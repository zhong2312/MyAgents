import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
  MapPin,
  Pencil,
  Plus,
  Route,
  Trash2,
  X,
} from "lucide-react";
import { pinyin } from "pinyin-pro";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ConfirmDialog,
  DraggableDialogFrame,
  useCloseLayer,
} from "@/workbench-sdk";

import type { CharacterRecord } from "./characterLibrarySchema";
import {
  NarrativeEntityMultiSelect,
  NarrativeEntitySelect,
  type NarrativeEntityOption,
} from "./NarrativeEntityPicker";
import NarrativeMarkdownField from "./NarrativeMarkdownField";
import type {
  NarrativeEngineering,
  NarrativeKeyNode,
  NarrativeKeyNodeLocation,
  PlotLine,
  PlotLineKind,
  PlotLineStoryRole,
  StoryArc,
} from "./narrativeEngineeringSchema";
import { orderedNarrativeChapters } from "./narrativePlanningModel";
import NarrativeSelect from "./NarrativeSelect";
import NarrativeTextField from "./NarrativeTextField";

interface NarrativeTracksProps {
  readonly mode: "lines" | "arcs";
  readonly library: NarrativeEngineering;
  readonly characters: readonly CharacterRecord[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onChange: (library: NarrativeEngineering) => void;
}

interface KeyNodeLocationOption extends NarrativeEntityOption {
  readonly chapterId: string;
  readonly sectionId: string | null;
}

const LINE_KIND_LABELS: Readonly<Record<PlotLineKind, string>> = {
  main: "主线",
  emotion: "情感支线",
  mirror: "镜像支线",
  information: "信息支线",
  theme: "主题支线",
  custom: "自定义线",
};

const LINE_KIND_COLORS: Readonly<Record<PlotLineKind, string>> = {
  main: "#b64a3a",
  emotion: "#c3812f",
  mirror: "#46766b",
  information: "#486c9c",
  theme: "#765b91",
  custom: "#687078",
};

const STORY_ROLE_LABELS: Readonly<Record<PlotLineStoryRole, string>> = {
  a: "A Story · 外在目标",
  b: "B Story · 内在需求",
  both: "A/B 交汇线",
  none: "暂不标记",
};

const ARC_KIND_LABELS: Readonly<Record<StoryArc["kind"], string>> = {
  plot: "情节弧",
  character: "角色弧",
  relationship: "关系弧",
  mystery: "悬念弧",
  theme: "主题弧",
  custom: "自定义弧",
};

function createId(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8);
  return `${prefix}-${token ?? Date.now().toString(36)}`;
}

function createLine(kind: PlotLineKind = "main"): PlotLine {
  return {
    id: createId("line"),
    title: kind === "main" ? "未命名主线" : "未命名支线",
    kind,
    storyRole: kind === "main" ? "a" : "none",
    status: "idea",
    color: LINE_KIND_COLORS[kind],
    premise: "",
    protagonistCharacterId: null,
    keyNodes: [],
    content: "",
  };
}

function createArc(): StoryArc {
  return {
    id: createId("arc"),
    title: "未命名故事弧",
    kind: "plot",
    characterId: null,
    characterArcStageId: null,
    characterArcStageTitle: "",
    lineIds: [],
    keyNodes: [],
    content: "",
  };
}

function characterOption(character: CharacterRecord): NarrativeEntityOption {
  const values = [character.name, character.alias].filter(Boolean);
  const pinyinKeywords = values.flatMap((value) => {
    const transliterated = pinyin(value, { toneType: "none" });
    return [transliterated, transliterated.replace(/\s+/gu, "")];
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

function locationOptionId(chapterId: string, sectionId: string | null): string {
  return sectionId
    ? `section:${chapterId}:${sectionId}`
    : `chapter:${chapterId}`;
}

function directoryPath(
  library: NarrativeEngineering,
  directoryId: string | null,
): string {
  if (!directoryId) return "未归类";
  const byId = new Map(
    library.directories.map((directory) => [directory.id, directory]),
  );
  const values: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = directoryId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const directory = byId.get(currentId);
    if (!directory) break;
    values.unshift(directory.title);
    currentId = directory.parentId;
  }
  return values.join(" / ") || "未归类";
}

function keyNodeLocationOptions(
  library: NarrativeEngineering,
): readonly KeyNodeLocationOption[] {
  return orderedNarrativeChapters(library.chapters).flatMap(
    (chapter, chapterIndex) => {
      const chapterNumber = String(chapterIndex + 1).padStart(2, "0");
      const prefix = `第${chapterNumber}章`;
      const directory = directoryPath(library, chapter.directoryId);
      const sections = [...chapter.sections].sort((left, right) =>
        left.order !== right.order
          ? left.order - right.order
          : left.id.localeCompare(right.id),
      );
      return [
        {
          id: locationOptionId(chapter.id, null),
          chapterId: chapter.id,
          sectionId: null,
          label: `${prefix} · 整章`,
          description: `${directory} / ${chapter.title}`,
          keywords: [chapter.title, directory, `第${chapterIndex + 1}章`],
        },
        ...sections.map((section, sectionIndex) => ({
          id: locationOptionId(chapter.id, section.id),
          chapterId: chapter.id,
          sectionId: section.id,
          label: `${prefix} · ${String(sectionIndex + 1).padStart(2, "0")}节`,
          description: `${directory} / ${chapter.title} / ${section.title || section.description || "未填写简述"}`,
          keywords: [
            chapter.title,
            section.title,
            section.description,
            directory,
            `第${chapterIndex + 1}章`,
            `${sectionIndex + 1}节`,
          ],
        })),
      ];
    },
  );
}

function orderedLocations(
  locations: readonly NarrativeKeyNodeLocation[],
  options: readonly KeyNodeLocationOption[],
): readonly NarrativeKeyNodeLocation[] {
  const optionIndex = new Map(
    options.map((option, index) => [option.id, index]),
  );
  return [...locations].sort((left, right) => {
    const leftIndex = optionIndex.get(
      locationOptionId(left.chapterId, left.sectionId),
    );
    const rightIndex = optionIndex.get(
      locationOptionId(right.chapterId, right.sectionId),
    );
    return (
      (leftIndex ?? Number.MAX_SAFE_INTEGER) -
      (rightIndex ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function LocationStrip({
  locations,
  options,
  onClick,
}: {
  readonly locations: readonly NarrativeKeyNodeLocation[];
  readonly options: readonly KeyNodeLocationOption[];
  readonly onClick: () => void;
}) {
  const optionById = useMemo(
    () => new Map(options.map((option) => [option.id, option])),
    [options],
  );
  const values = orderedLocations(locations, options).map((location) =>
    optionById.get(locationOptionId(location.chapterId, location.sectionId)),
  );
  const visible = values.slice(0, 3);
  const hiddenCount = Math.max(0, values.length - visible.length);
  const title = values
    .map((location) => location?.description ?? "已失效关联")
    .join("\n");
  return (
    <button
      type="button"
      className={`ne-key-node-location-strip ${values.length === 0 ? "is-empty" : ""}`}
      title={title || "关联章节或节"}
      onClick={onClick}
    >
      {values.length === 0 ? (
        <span>未关联章节或节</span>
      ) : (
        <>
          {visible.map((location, index) => (
            <span
              key={`${location?.id ?? "missing"}-${index}`}
              className="ne-key-node-location-chip"
            >
              {location?.label ?? "已失效关联"}
            </span>
          ))}
          {hiddenCount > 0 && (
            <span className="ne-key-node-location-more">+{hiddenCount}</span>
          )}
        </>
      )}
    </button>
  );
}

function KeyNodeLocationDialog({
  node,
  library,
  onChange,
  onClose,
}: {
  readonly node: NarrativeKeyNode;
  readonly library: NarrativeEngineering;
  readonly onChange: (node: NarrativeKeyNode) => void;
  readonly onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  const options = useMemo(() => keyNodeLocationOptions(library), [library]);
  const optionById = useMemo(
    () => new Map(options.map((option) => [option.id, option])),
    [options],
  );
  const values = node.locations.map((location) =>
    locationOptionId(location.chapterId, location.sectionId),
  );
  const updateLocations = (nextValues: readonly string[]) => {
    const existingByTarget = new Map(
      node.locations.map((location) => [
        locationOptionId(location.chapterId, location.sectionId),
        location,
      ]),
    );
    onChange({
      ...node,
      locations: nextValues.flatMap((value) => {
        const option = optionById.get(value);
        if (!option) return [];
        return [
          existingByTarget.get(value) ?? {
            id: createId("key-location"),
            chapterId: option.chapterId,
            sectionId: option.sectionId,
          },
        ];
      }),
    });
  };
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useCloseLayer(() => {
    closeRef.current();
    return true;
  }, 280);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selected = orderedLocations(node.locations, options);
  return (
    <DraggableDialogFrame
      ariaLabel={`${node.title}的关联位置`}
      className="h-[min(38rem,calc(100vh-3rem))] w-[min(44rem,calc(100vw-2rem))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-14 items-center gap-3 px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--paper-inset)] text-[var(--accent-warm)]">
            <MapPin className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-[var(--ink)]">
              {node.title} · 关联位置
            </h2>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              已关联 {selected.length} 处；可搜索章节、节和标题。
            </p>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            title="关闭"
            aria-label="关闭关联位置"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="ne-panel-scroll min-h-0 flex-1 p-4">
        <section>
          <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
            已关联位置
          </h3>
          {selected.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--ink-muted)]">
              尚未关联章节或节。
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {selected.map((location) => {
                const option = optionById.get(
                  locationOptionId(location.chapterId, location.sectionId),
                );
                return (
                  <button
                    key={location.id}
                    type="button"
                    className="ne-key-node-dialog-chip"
                    title={`移除 ${option?.description ?? "失效关联"}`}
                    onClick={() =>
                      updateLocations(
                        values.filter(
                          (value) =>
                            value !==
                            locationOptionId(
                              location.chapterId,
                              location.sectionId,
                            ),
                        ),
                      )
                    }
                  >
                    <span>{option?.label ?? "已失效关联"}</span>
                    <X className="h-3.5 w-3.5" />
                  </button>
                );
              })}
            </div>
          )}
        </section>
        <section className="mt-6 border-t border-[var(--line)] pt-5">
          <h3 className="mb-2 text-xs font-semibold text-[var(--ink-muted)]">
            关联章节或节
          </h3>
          <NarrativeEntityMultiSelect
            values={values}
            options={options}
            placeholder="搜索章节、节或标题"
            ariaLabel="关键节点关联章节或节"
            disabled={options.length === 0}
            onChange={updateLocations}
          />
          {options.length === 0 && (
            <p className="mt-3 text-xs leading-5 text-[var(--ink-muted)]">
              请先在章节页面建立章节和节，再回到这里关联关键节点。
            </p>
          )}
        </section>
      </div>
      <div className="flex shrink-0 justify-end border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3">
        <button
          type="button"
          className="ns-button is-primary"
          onClick={onClose}
        >
          完成
        </button>
      </div>
    </DraggableDialogFrame>
  );
}

function KeyNodeSection({
  nodes,
  library,
  onChange,
}: {
  readonly nodes: readonly NarrativeKeyNode[];
  readonly library: NarrativeEngineering;
  readonly onChange: (nodes: readonly NarrativeKeyNode[]) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [locationNodeId, setLocationNodeId] = useState<string | null>(null);
  const options = useMemo(() => keyNodeLocationOptions(library), [library]);
  const orderedNodes = useMemo(
    () =>
      [...nodes].sort((left, right) =>
        left.order !== right.order
          ? left.order - right.order
          : left.id.localeCompare(right.id),
      ),
    [nodes],
  );
  const updateNode = (nextNode: NarrativeKeyNode) =>
    onChange(nodes.map((node) => (node.id === nextNode.id ? nextNode : node)));
  const addNode = () => {
    const node: NarrativeKeyNode = {
      id: createId("key-node"),
      title: "未命名关键节点",
      content: "",
      order: nodes.length,
      locations: [],
    };
    onChange([...nodes, node]);
    setExpandedId(node.id);
  };
  const removeNode = (nodeId: string) => {
    onChange(
      orderedNodes
        .filter((node) => node.id !== nodeId)
        .map((node, index) => ({ ...node, order: index })),
    );
    if (expandedId === nodeId) setExpandedId(null);
  };
  const moveNode = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= orderedNodes.length) return;
    const next = [...orderedNodes];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((node, order) => ({ ...node, order })));
  };
  const locationNode = nodes.find((node) => node.id === locationNodeId) ?? null;
  return (
    <section className="mt-7 border-t border-[var(--line)] pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-[var(--accent-warm)]" />
          <h3 className="text-sm font-semibold">关键节点</h3>
          <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs tabular-nums text-[var(--ink-muted)]">
            {nodes.length}
          </span>
        </div>
        <button type="button" className="ns-button" onClick={addNode}>
          <Plus className="h-3.5 w-3.5" />
          新增节点
        </button>
      </div>
      {orderedNodes.length === 0 ? (
        <div className="mt-4 border border-dashed border-[var(--line-strong)] px-4 py-7 text-center text-sm text-[var(--ink-muted)]">
          用关键节点标记这条线路或故事弧的重要变化，并关联到多个章节或节。
        </div>
      ) : (
        <div className="mt-4 divide-y divide-[var(--line)] border-y border-[var(--line)]">
          {orderedNodes.map((node, index) => {
            const expanded = expandedId === node.id;
            return (
              <article key={node.id}>
                <div className="flex min-w-0 items-center gap-2 px-3 py-3">
                  <span className="w-6 shrink-0 text-center font-mono text-xs text-[var(--ink-subtle)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : node.id)}
                  >
                    <span className="block truncate text-sm font-medium text-[var(--ink)]">
                      {node.title}
                    </span>
                    {node.content.trim() && (
                      <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                        {node.content}
                      </span>
                    )}
                  </button>
                  <LocationStrip
                    locations={node.locations}
                    options={options}
                    onClick={() => setLocationNodeId(node.id)}
                  />
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      className="ns-icon-button h-7 w-7 border-0"
                      title="上移节点"
                      aria-label="上移节点"
                      disabled={index === 0}
                      onClick={() => moveNode(index, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="ns-icon-button h-7 w-7 border-0"
                      title="下移节点"
                      aria-label="下移节点"
                      disabled={index === orderedNodes.length - 1}
                      onClick={() => moveNode(index, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="ns-icon-button h-7 w-7 border-0"
                      title={expanded ? "收起节点" : "编辑节点"}
                      aria-label={expanded ? "收起节点" : "编辑节点"}
                      onClick={() => setExpandedId(expanded ? null : node.id)}
                    >
                      {expanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <Pencil className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="ns-icon-button h-7 w-7 border-0 text-[var(--error)]"
                      title="删除节点"
                      aria-label="删除节点"
                      onClick={() => removeNode(node.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="border-t border-[var(--line-subtle)] bg-[var(--paper-inset)] px-4 py-4">
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                        节点标题
                      </span>
                      <input
                        value={node.title}
                        className="ne-input"
                        onChange={(event) =>
                          updateNode({ ...node, title: event.target.value })
                        }
                      />
                    </label>
                    <div className="mt-4">
                      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                        关联位置
                      </span>
                      <LocationStrip
                        locations={node.locations}
                        options={options}
                        onClick={() => setLocationNodeId(node.id)}
                      />
                    </div>
                    <div className="mt-4">
                      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                        节点内容
                      </span>
                      <NarrativeMarkdownField
                        pageId={`key-node:${node.id}`}
                        label="节点内容"
                        value={node.content}
                        placeholder="记录这个关键节点发生了什么、造成了什么变化。"
                        className="ne-track-markdown-field is-compact"
                        onChange={(content) => updateNode({ ...node, content })}
                      />
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {locationNode && (
        <KeyNodeLocationDialog
          node={locationNode}
          library={library}
          onChange={updateNode}
          onClose={() => setLocationNodeId(null)}
        />
      )}
    </section>
  );
}

function EditorTabs({
  active,
  onChange,
}: {
  readonly active: "config" | "content";
  readonly onChange: (tab: "config" | "content") => void;
}) {
  return (
    <div
      className="mt-5 flex border-b border-[var(--line)]"
      role="tablist"
      aria-label="详情页面"
    >
      {(
        [
          ["config", "配置"],
          ["content", "内容"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          className={`border-b-2 px-3 py-2 text-sm font-medium ${active === id ? "border-[var(--accent-warm)] text-[var(--ink)]" : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function LineEditor({
  line,
  library,
  characters,
  onChange,
  onDelete,
}: {
  readonly line: PlotLine;
  readonly library: NarrativeEngineering;
  readonly characters: readonly CharacterRecord[];
  readonly onChange: (line: PlotLine) => void;
  readonly onDelete: () => void;
}) {
  const [tab, setTab] = useState<"config" | "content">("config");
  const characterOptions = useMemo<NarrativeEntityOption[]>(
    () => [{ id: "", label: "暂不关联" }, ...characters.map(characterOption)],
    [characters],
  );
  return (
    <div className="ne-panel-scroll h-full bg-[var(--paper)]">
      <div className="mx-auto max-w-4xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--paper-inset)]"
              style={{ color: line.color }}
            >
              <Route className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{line.title}</h2>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                线路在章、节中的规划和关键节点投影。
              </p>
            </div>
          </div>
          <button
            type="button"
            className="ns-button is-danger shrink-0"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除线路
          </button>
        </div>
        <EditorTabs active={tab} onChange={setTab} />
        {tab === "config" ? (
          <>
            <div className="ne-field-grid mt-5">
              <label>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  线路名称
                </span>
                <input
                  value={line.title}
                  onChange={(event) =>
                    onChange({ ...line, title: event.target.value })
                  }
                  className="ne-input"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  线路类型
                </span>
                <NarrativeSelect
                  value={line.kind}
                  className="w-full"
                  onChange={(event) => {
                    const kind = event.target.value as PlotLineKind;
                    onChange({ ...line, kind, color: LINE_KIND_COLORS[kind] });
                  }}
                >
                  {Object.entries(LINE_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NarrativeSelect>
              </label>
              <label>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  A/B Story
                </span>
                <NarrativeSelect
                  value={line.storyRole}
                  className="w-full"
                  onChange={(event) =>
                    onChange({
                      ...line,
                      storyRole: event.target.value as PlotLineStoryRole,
                    })
                  }
                >
                  {Object.entries(STORY_ROLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NarrativeSelect>
              </label>
              <label>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  状态
                </span>
                <NarrativeSelect
                  value={line.status}
                  className="w-full"
                  onChange={(event) =>
                    onChange({
                      ...line,
                      status: event.target.value as PlotLine["status"],
                    })
                  }
                >
                  <option value="idea">构思</option>
                  <option value="active">推进中</option>
                  <option value="resolved">已解决</option>
                  <option value="paused">暂停</option>
                </NarrativeSelect>
              </label>
              <div className="col-span-full">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  中心角色
                </span>
                <NarrativeEntitySelect
                  value={line.protagonistCharacterId ?? ""}
                  options={characterOptions}
                  placeholder="搜索人物库角色"
                  ariaLabel="线路中心角色"
                  onChange={(value) =>
                    onChange({ ...line, protagonistCharacterId: value || null })
                  }
                />
              </div>
              <NarrativeTextField
                id={`line-${line.id}-premise`}
                label="一句话线路"
                value={line.premise}
                onChange={(premise) => onChange({ ...line, premise })}
                placeholder="谁为了什么，在何种阻碍下采取行动？"
                size="short"
                wide
              />
            </div>
            <KeyNodeSection
              nodes={line.keyNodes}
              library={library}
              onChange={(keyNodes) =>
                onChange({ ...line, keyNodes: [...keyNodes] })
              }
            />
          </>
        ) : (
          <section className="ne-track-content mt-5">
            <NarrativeMarkdownField
              pageId={`line:${line.id}:content`}
              label="线路内容"
              value={line.content}
              onChange={(content) => onChange({ ...line, content })}
              placeholder="自由记录这条线路的推演、资料和备选方案……"
              className="ne-track-markdown-field"
            />
          </section>
        )}
      </div>
    </div>
  );
}

function ArcEditor({
  arc,
  library,
  characters,
  onChange,
  onDelete,
}: {
  readonly arc: StoryArc;
  readonly library: NarrativeEngineering;
  readonly characters: readonly CharacterRecord[];
  readonly onChange: (arc: StoryArc) => void;
  readonly onDelete: () => void;
}) {
  const [tab, setTab] = useState<"config" | "content">("config");
  const character =
    characters.find((candidate) => candidate.id === arc.characterId) ?? null;
  const characterOptions = useMemo<NarrativeEntityOption[]>(
    () => [{ id: "", label: "暂不关联" }, ...characters.map(characterOption)],
    [characters],
  );
  const lineOptions = useMemo<NarrativeEntityOption[]>(
    () =>
      library.lines.map((line) => ({
        id: line.id,
        label: line.title,
        description: LINE_KIND_LABELS[line.kind],
      })),
    [library.lines],
  );
  const stageOptions = [
    { id: "", label: "整条人物弧 / 暂不指定" },
    ...(character?.arcStages.flatMap((stage, index) =>
      stage.id
        ? [
            {
              id: stage.id,
              label: stage.title || `阶段 ${index + 1}`,
              description: stage.state || "人物库弧阶段",
            },
          ]
        : [],
    ) ?? []),
  ];
  const stageExists = stageOptions.some(
    (option) => option.id === arc.characterArcStageId,
  );
  if (arc.characterArcStageId && !stageExists) {
    stageOptions.splice(1, 0, {
      id: arc.characterArcStageId,
      label: `已失效 · ${arc.characterArcStageTitle || "未命名阶段"}`,
      description: "请重新关联人物弧阶段",
    });
  }
  return (
    <div className="ne-panel-scroll h-full bg-[var(--paper)]">
      <div className="mx-auto max-w-4xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--paper-inset)] text-[var(--accent-cool)]">
              <GitBranch className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{arc.title}</h2>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                人物总弧光仍由人物库拥有；这里记录故事中的投影。
              </p>
            </div>
          </div>
          <button
            type="button"
            className="ns-button is-danger shrink-0"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除故事弧
          </button>
        </div>
        <EditorTabs active={tab} onChange={setTab} />
        {tab === "config" ? (
          <>
            <div className="ne-field-grid mt-5">
              <label>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  故事弧名称
                </span>
                <input
                  value={arc.title}
                  onChange={(event) =>
                    onChange({ ...arc, title: event.target.value })
                  }
                  className="ne-input"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  弧类型
                </span>
                <NarrativeSelect
                  value={arc.kind}
                  className="w-full"
                  onChange={(event) =>
                    onChange({
                      ...arc,
                      kind: event.target.value as StoryArc["kind"],
                    })
                  }
                >
                  {Object.entries(ARC_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NarrativeSelect>
              </label>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  人物库角色
                </span>
                <NarrativeEntitySelect
                  value={arc.characterId ?? ""}
                  options={characterOptions}
                  placeholder="搜索人物库角色"
                  ariaLabel="故事弧关联人物"
                  onChange={(value) =>
                    onChange({
                      ...arc,
                      characterId: value || null,
                      characterArcStageId: null,
                      characterArcStageTitle: "",
                    })
                  }
                />
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  人物弧阶段
                </span>
                <NarrativeEntitySelect
                  value={arc.characterArcStageId ?? ""}
                  options={stageOptions}
                  placeholder={character ? "选择人物弧阶段" : "先关联人物"}
                  ariaLabel="人物弧阶段"
                  disabled={!character}
                  onChange={(value) => {
                    const stage = character?.arcStages.find(
                      (candidate) => candidate.id === value,
                    );
                    onChange({
                      ...arc,
                      characterArcStageId: value || null,
                      characterArcStageTitle: stage?.title ?? "",
                    });
                  }}
                />
              </div>
              <div className="col-span-full">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  关联剧情线
                </span>
                <NarrativeEntityMultiSelect
                  values={arc.lineIds}
                  options={lineOptions}
                  placeholder="选择关联线路"
                  ariaLabel="故事弧关联线路"
                  disabled={lineOptions.length === 0}
                  onChange={(lineIds) => onChange({ ...arc, lineIds })}
                />
              </div>
            </div>
            {character && (
              <div className="mt-5 border-l-2 border-[var(--accent-cool)] bg-[var(--accent-warm-subtle)] px-4 py-3">
                <p className="text-xs font-semibold text-[var(--accent-cool)]">
                  人物库总弧光 · {character.name}
                </p>
                <p className="mt-1 text-sm leading-6 text-[var(--ink-secondary)]">
                  {character.arc || "人物库尚未填写总弧光。"}
                </p>
              </div>
            )}
            <KeyNodeSection
              nodes={arc.keyNodes}
              library={library}
              onChange={(keyNodes) =>
                onChange({ ...arc, keyNodes: [...keyNodes] })
              }
            />
          </>
        ) : (
          <section className="ne-track-content mt-5">
            <NarrativeMarkdownField
              pageId={`arc:${arc.id}:content`}
              label="故事弧内容"
              value={arc.content}
              onChange={(content) => onChange({ ...arc, content })}
              placeholder="自由记录这条故事弧的推演、资料和备选方案……"
              className="ne-track-markdown-field"
            />
          </section>
        )}
      </div>
    </div>
  );
}

export default function NarrativeTracks({
  mode,
  library,
  characters,
  selectedId,
  onSelect,
  onChange,
}: NarrativeTracksProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const records = mode === "lines" ? library.lines : library.arcs;
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const add = () => {
    if (mode === "lines") {
      const line = createLine(library.lines.length === 0 ? "main" : "custom");
      onChange({ ...library, lines: [...library.lines, line] });
      onSelect(line.id);
    } else {
      const arc = createArc();
      onChange({ ...library, arcs: [...library.arcs, arc] });
      onSelect(arc.id);
    }
  };
  const remove = () => {
    if (!deleteId) return;
    if (mode === "lines") {
      onChange({
        ...library,
        lines: library.lines.filter((line) => line.id !== deleteId),
        arcs: library.arcs.map((arc) => ({
          ...arc,
          lineIds: arc.lineIds.filter((id) => id !== deleteId),
        })),
        chapters: library.chapters.map((chapter) => ({
          ...chapter,
          lineIds: chapter.lineIds.filter((id) => id !== deleteId),
          sections: chapter.sections.map((section) => ({
            ...section,
            lineIds: section.lineIds.filter((id) => id !== deleteId),
          })),
        })),
      });
    } else {
      onChange({
        ...library,
        arcs: library.arcs.filter((arc) => arc.id !== deleteId),
        chapters: library.chapters.map((chapter) => ({
          ...chapter,
          arcIds: chapter.arcIds.filter((id) => id !== deleteId),
          sections: chapter.sections.map((section) => ({
            ...section,
            arcIds: section.arcIds.filter((id) => id !== deleteId),
          })),
        })),
      });
    }
    const remaining = records.filter((record) => record.id !== deleteId);
    onSelect(remaining[0]?.id ?? "");
    setDeleteId(null);
  };

  return (
    <div className="ne-track-workspace h-full min-h-0">
      <aside className="flex min-h-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-3">
          <div>
            <h2 className="text-sm font-semibold">
              {mode === "lines" ? "剧情线路" : "故事弧"}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              {records.length} 条
            </p>
          </div>
          <button type="button" className="ns-button" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新建
          </button>
        </div>
        <div className="ne-panel-scroll flex-1 py-1">
          {records.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--ink-muted)]">
              尚未创建{mode === "lines" ? "剧情线路" : "故事弧"}。
            </div>
          ) : (
            records.map((record) => {
              const isLine = mode === "lines";
              const line = isLine ? (record as PlotLine) : null;
              return (
                <button
                  key={record.id}
                  type="button"
                  className={`flex w-full min-w-0 items-center gap-3 border-b border-[var(--line-subtle)] px-3 py-3 text-left ${selectedId === record.id ? "bg-[var(--accent-warm-muted)]" : "hover:bg-[var(--hover-bg)]"}`}
                  onClick={() => onSelect(record.id)}
                >
                  <span
                    className="h-8 w-1 shrink-0 rounded-sm"
                    style={{
                      backgroundColor: line?.color ?? "var(--accent-cool)",
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {record.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                      {line
                        ? `${LINE_KIND_LABELS[line.kind]} · ${STORY_ROLE_LABELS[line.storyRole]}`
                        : ARC_KIND_LABELS[(record as StoryArc).kind]}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>
      <main className="min-h-0 min-w-0">
        {!selected ? (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="max-w-sm">
              {mode === "lines" ? (
                <Route className="mx-auto h-8 w-8 text-[var(--ink-subtle)]" />
              ) : (
                <GitBranch className="mx-auto h-8 w-8 text-[var(--ink-subtle)]" />
              )}
              <h2 className="mt-4 text-sm font-semibold">
                选择或创建{mode === "lines" ? "线路" : "故事弧"}
              </h2>
            </div>
          </div>
        ) : mode === "lines" ? (
          <LineEditor
            line={selected as PlotLine}
            library={library}
            characters={characters}
            onChange={(line) =>
              onChange({
                ...library,
                lines: library.lines.map((candidate) =>
                  candidate.id === line.id ? line : candidate,
                ),
              })
            }
            onDelete={() => setDeleteId(selected.id)}
          />
        ) : (
          <ArcEditor
            arc={selected as StoryArc}
            library={library}
            characters={characters}
            onChange={(arc) =>
              onChange({
                ...library,
                arcs: library.arcs.map((candidate) =>
                  candidate.id === arc.id ? arc : candidate,
                ),
              })
            }
            onDelete={() => setDeleteId(selected.id)}
          />
        )}
      </main>
      {deleteId && (
        <ConfirmDialog
          title={mode === "lines" ? "删除剧情线路" : "删除故事弧"}
          message={`确认删除“${records.find((record) => record.id === deleteId)?.title ?? "当前对象"}”？章和节上的关联会同步清理。`}
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={remove}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
