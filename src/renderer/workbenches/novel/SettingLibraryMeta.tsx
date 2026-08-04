import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  FileCode2,
  History,
  ListTree,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CustomSelect, type SelectOption } from "@/workbench-sdk";

import type { LoadedSettingLibrary } from "./settingLibraryRepository";
import type { NovelAiAssistTarget } from "./aiAssistTypes";
import type {
  LevelType,
  SettingLibraryMeta,
  SettingTemplate,
} from "./settingLibrarySchema";

type MetaTab = "types" | "templates" | "profiles";

interface SettingLibraryMetaProps {
  readonly library: LoadedSettingLibrary;
  readonly projectTitle: string;
  readonly isSaving: boolean;
  readonly error: string | null;
  readonly onSave: (meta: SettingLibraryMeta) => Promise<void>;
  readonly onAiAssist?: (
    target: NovelAiAssistTarget,
    localContext?: unknown,
  ) => Promise<string | null>;
  readonly headerActions?: ReactNode;
}

const MAP_KIND_OPTIONS: SelectOption[] = [
  { value: "cosmic-region", label: "宇宙区域" },
  { value: "stellar-region", label: "星域轮廓" },
  { value: "planet-point", label: "行星点位" },
  { value: "geographic-area", label: "地理面" },
  { value: "settlement-point", label: "聚落点位" },
  { value: "hidden", label: "不在地图显示" },
];

const ICON_OPTIONS: SelectOption[] = [
  { value: "orbit", label: "轨道" },
  { value: "globe-2", label: "世界" },
  { value: "sparkles", label: "星群" },
  { value: "sun", label: "恒星" },
  { value: "circle-dot", label: "星球" },
  { value: "land-plot", label: "疆域" },
  { value: "flag", label: "国家" },
  { value: "map", label: "区域" },
  { value: "building-2", label: "城市" },
  { value: "landmark", label: "地标" },
  { value: "brackets", label: "自定义" },
];

function uniqueId(prefix: string): string {
  const token =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);
  return `${prefix}-${token}`;
}

/** 编辑模板内容时自动递增版本号（x.y.z -> x.y.(z+1)），用于提示已落盘页面的旧模板状态。 */
function bumpTemplateVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return version;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * 对比草稿与落盘基线，对内容字段（名称/分组/说明/骨架/引导）发生变化
 * 且版本号尚未变化的模板统一递增一次版本。归档/恢复不递增。
 */
function bumpChangedTemplateVersions(
  next: SettingLibraryMeta,
  baseline: SettingLibraryMeta,
): SettingLibraryMeta {
  const baselineTemplates = new Map(
    baseline.settingTemplates.map((template) => [template.id, template]),
  );
  let changed = false;
  const settingTemplates = next.settingTemplates.map((template) => {
    const base = baselineTemplates.get(template.id);
    if (!base) return template;
    const contentChanged =
      template.name !== base.name ||
      template.group !== base.group ||
      template.description !== base.description ||
      template.skeleton !== base.skeleton ||
      template.agentGuide !== base.agentGuide;
    if (contentChanged && template.version === base.version) {
      changed = true;
      return { ...template, version: bumpTemplateVersion(template.version) };
    }
    return template;
  });
  return changed ? { ...next, settingTemplates } : next;
}

function replaceType(
  meta: SettingLibraryMeta,
  id: string,
  update: (type: LevelType) => LevelType,
): SettingLibraryMeta {
  return {
    ...meta,
    levelTypes: meta.levelTypes.map((type) =>
      type.id === id ? update(type) : type,
    ),
  };
}

function replaceTemplate(
  meta: SettingLibraryMeta,
  id: string,
  update: (template: SettingTemplate) => SettingTemplate,
): SettingLibraryMeta {
  return {
    ...meta,
    settingTemplates: meta.settingTemplates.map((template) =>
      template.id === id ? update(template) : template,
    ),
  };
}

function moveItem<T>(
  items: readonly T[],
  index: number,
  direction: -1 | 1,
): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function PreviewDialog({
  template,
  onClose,
}: {
  readonly template: SettingTemplate;
  readonly onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-preview-title"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <div className="text-xs text-[var(--ink-muted)]">Markdown 预览</div>
            <h2
              id="template-preview-title"
              className="mt-1 text-lg font-semibold"
            >
              {template.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭模板预览"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6 text-base leading-8 [&_h1]:mb-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {template.skeleton}
          </ReactMarkdown>
        </div>
      </section>
    </div>
  );
}

export default function SettingLibraryMeta({
  library,
  projectTitle,
  isSaving,
  error,
  onSave,
  onAiAssist,
  headerActions,
}: SettingLibraryMetaProps) {
  const [tab, setTab] = useState<MetaTab>("types");
  const [draft, setDraft] = useState<SettingLibraryMeta>(library.meta);
  const [selectedTypeId, setSelectedTypeId] = useState(
    library.meta.levelTypes.find((type) => type.id === "universe")?.id ??
      library.meta.levelTypes[0]?.id ??
      "",
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    library.meta.settingTemplates[0]?.id ?? "",
  );
  const [profileTypeId, setProfileTypeId] = useState(selectedTypeId);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [previewTemplate, setPreviewTemplate] =
    useState<SettingTemplate | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(library.meta),
    [draft, library.meta],
  );
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  const onSaveRef = useRef(onSave);
  const libraryRef = useRef(library);

  useEffect(() => {
    draftRef.current = draft;
    dirtyRef.current = dirty;
    onSaveRef.current = onSave;
    libraryRef.current = library;
  }, [dirty, draft, library, onSave]);

  // 保存时对内容发生变化的模板统一递增一次版本（而非每次按键），
  // 并把 bump 后的版本同步回 draft，避免 dirty 无法收敛。
  const saveDraft = useCallback(async (next: SettingLibraryMeta) => {
    const baseline = libraryRef.current;
    const bumped = bumpChangedTemplateVersions(next, baseline.meta);
    if (bumped !== next) setDraft(bumped);
    await onSaveRef.current(bumped);
  }, []);

  useEffect(() => {
    if (!dirty || isSaving) return;
    const timer = window.setTimeout(() => void saveDraft(draft), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, isSaving, saveDraft]);

  useEffect(
    () => () => {
      if (dirtyRef.current) void saveDraft(draftRef.current);
    },
    [saveDraft],
  );
  const selectedType =
    draft.levelTypes.find((type) => type.id === selectedTypeId) ??
    draft.levelTypes[0];
  const selectedTemplate =
    draft.settingTemplates.find(
      (template) => template.id === selectedTemplateId,
    ) ?? draft.settingTemplates[0];
  const groups = [
    ...new Set(draft.settingTemplates.map((item) => item.group)),
  ].sort((left, right) => left.localeCompare(right, "zh-CN"));

  const createType = () => {
    const id = uniqueId("type");
    const type: LevelType = {
      id,
      name: "新层级类型",
      description: "",
      icon: "brackets",
      mapKind: "hidden",
      source: "project",
      suggestedParentTypeIds: [],
      suggestedChildTypeIds: [],
    };
    setDraft((current) => ({
      ...current,
      levelTypes: [...current.levelTypes, type],
      profiles: [...current.profiles, { levelTypeId: id, templateIds: [] }],
    }));
    setSelectedTypeId(id);
  };

  const createTemplate = () => {
    const id = uniqueId("template");
    const template: SettingTemplate = {
      id,
      name: "新设定模板",
      group: "世界",
      description: "",
      source: "project",
      version: "1.0.0",
      skeleton: "# 新设定模板\n\n## 核心内容\n",
      agentGuide: "仅依据作者已提供的事实协助完善。",
    };
    setDraft((current) => ({
      ...current,
      settingTemplates: [...current.settingTemplates, template],
    }));
    setSelectedTemplateId(id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2 max-md:flex-wrap">
        <div className="flex min-w-0 items-center gap-3">
          <FileCode2 className="h-5 w-5 shrink-0 text-[var(--accent-warm)]" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">模板配置</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {draft.settingTemplates.length} 个设定模板 ·{" "}
              {isSaving ? "保存中" : dirty ? "待保存" : "已保存"}
            </p>
          </div>
        </div>
        {headerActions && (
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
          </div>
        )}
      </header>
      {error && (
        <div className="border-b border-[var(--line)] bg-[var(--error-bg)] px-5 py-2 text-xs text-[var(--error)]">
          {error}
        </div>
      )}
      <nav className="flex h-12 shrink-0 items-end gap-6 border-b border-[var(--line)] px-6">
        {(
          [
            ["types", "层级类型", Tags, draft.levelTypes.length],
            ["templates", "设定模板", FileCode2, draft.settingTemplates.length],
            ["profiles", "类型模板关联", ListTree, null],
          ] as const
        ).map(([id, label, Icon, count]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              setTab(id);
              setQuery("");
            }}
            className={`flex h-full items-center gap-2 border-b-2 text-sm font-medium ${
              tab === id
                ? "border-[var(--accent-cool)] text-[var(--ink)]"
                : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
            {count !== null && (
              <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs">
                {count}
              </span>
            )}
          </button>
        ))}
      </nav>

      {tab === "types" && selectedType && (
        <div className="grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] max-md:grid-cols-1">
          <aside className="min-h-0 overflow-y-auto border-r border-[var(--line)] p-4 max-md:hidden">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">层级类型</h2>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  可编辑、复制和排序
                </p>
              </div>
              <button
                type="button"
                onClick={createType}
                aria-label="新建层级类型"
                title="新建层级类型"
                className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <label className="flex h-9 items-center gap-2 rounded-md border border-[var(--line)] px-2.5">
              <Search className="h-4 w-4 text-[var(--ink-muted)]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索类型"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>
            <div className="mt-3 space-y-1">
              {draft.levelTypes
                .filter((type) =>
                  `${type.name}${type.description}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((type) => {
                  const usage = library.spatialTree.nodes.filter(
                    (node) => node.typeId === type.id,
                  ).length;
                  return (
                    <button
                      key={type.id}
                      type="button"
                      onClick={() => setSelectedTypeId(type.id)}
                      className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left ${
                        selectedType.id === type.id
                          ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)]"
                          : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      }`}
                    >
                      <span className="truncate text-sm font-medium">
                        {type.name}
                      </span>
                      <span className="ml-2 text-xs">{usage}</span>
                    </button>
                  );
                })}
            </div>
          </aside>
          <section className="min-h-0 overflow-y-auto px-7 pt-6 pb-24 max-md:px-4">
            <header className="flex items-start justify-between gap-4 border-b border-[var(--line-subtle)] pb-5">
              <div>
                <span className="text-xs text-[var(--ink-muted)]">
                  {selectedType.source === "builtin"
                    ? "内置初始模板 · 项目副本"
                    : "项目自定义"}
                </span>
                <h2 className="mt-1 text-xl font-semibold">
                  {selectedType.name}
                </h2>
              </div>
              <div className="flex gap-2">
                {onAiAssist && (
                  <button
                    type="button"
                    onClick={() =>
                      onAiAssist(
                        {
                          kind: "level-type",
                          label: `完善层级类型“${selectedType.name}”`,
                          entityId: selectedType.id,
                        },
                        { metaDraft: draft },
                      )
                    }
                    className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-2.5 text-sm text-[var(--accent-cool)]"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> AI 完善
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const id = uniqueId("type");
                    const copy = {
                      ...selectedType,
                      id,
                      name: `${selectedType.name}副本`,
                      source: "project" as const,
                    };
                    setDraft((current) => ({
                      ...current,
                      levelTypes: [...current.levelTypes, copy],
                      profiles: [
                        ...current.profiles,
                        { levelTypeId: id, templateIds: [] },
                      ],
                    }));
                    setSelectedTypeId(id);
                  }}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm"
                >
                  <Copy className="h-3.5 w-3.5" /> 复制
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) =>
                      replaceType(current, selectedType.id, (type) => ({
                        ...type,
                        archived: !type.archived,
                      })),
                    )
                  }
                  aria-label={
                    selectedType.archived ? "恢复层级类型" : "归档层级类型"
                  }
                  title={
                    selectedType.archived ? "恢复层级类型" : "归档层级类型"
                  }
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)]"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </div>
            </header>
            <div className="grid max-w-4xl grid-cols-2 gap-5 py-6 max-md:grid-cols-1">
              <label className="text-sm">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  类型名称
                </span>
                <input
                  value={selectedType.name}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceType(current, selectedType.id, (type) => ({
                        ...type,
                        name: event.target.value,
                      })),
                    )
                  }
                  className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 outline-none focus:border-[var(--accent-cool)]"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  地图表现类型
                </span>
                <CustomSelect
                  value={selectedType.mapKind}
                  options={MAP_KIND_OPTIONS}
                  onChange={(value) =>
                    setDraft((current) =>
                      replaceType(current, selectedType.id, (type) => ({
                        ...type,
                        mapKind: value as LevelType["mapKind"],
                      })),
                    )
                  }
                />
              </label>
              <label className="col-span-2 text-sm max-md:col-span-1">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  说明
                </span>
                <textarea
                  rows={3}
                  value={selectedType.description}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceType(current, selectedType.id, (type) => ({
                        ...type,
                        description: event.target.value,
                      })),
                    )
                  }
                  className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 outline-none focus:border-[var(--accent-cool)]"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  图标
                </span>
                <CustomSelect
                  value={selectedType.icon}
                  options={ICON_OPTIONS}
                  onChange={(value) =>
                    setDraft((current) =>
                      replaceType(current, selectedType.id, (type) => ({
                        ...type,
                        icon: value,
                      })),
                    )
                  }
                />
              </label>
              <label className="text-sm">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  正在使用
                </span>
                <input
                  value={`${library.spatialTree.nodes.filter((node) => node.typeId === selectedType.id).length} 个空间节点`}
                  disabled
                  className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-inset)] px-3 text-[var(--ink-muted)]"
                />
              </label>
            </div>
            {(
              [
                [
                  "suggestedParentTypeIds",
                  "建议父类型",
                  "仅用于新建时提示，不限制空间树",
                ],
                [
                  "suggestedChildTypeIds",
                  "建议子类型",
                  "作者始终可以选择其他类型",
                ],
              ] as const
            ).map(([field, title, hint]) => (
              <section
                key={field}
                className="border-t border-[var(--line-subtle)] py-5"
              >
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">{hint}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {draft.levelTypes
                    .filter((type) => type.id !== selectedType.id)
                    .map((type) => {
                      const checked = selectedType[field].includes(type.id);
                      return (
                        <label
                          key={type.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                            checked
                              ? "border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)]"
                              : "border-[var(--line)]"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setDraft((current) =>
                                replaceType(
                                  current,
                                  selectedType.id,
                                  (item) => ({
                                    ...item,
                                    [field]: checked
                                      ? item[field].filter(
                                          (id) => id !== type.id,
                                        )
                                      : [...item[field], type.id],
                                  }),
                                ),
                              )
                            }
                          />
                          {type.name}
                        </label>
                      );
                    })}
                </div>
              </section>
            ))}
          </section>
        </div>
      )}

      {tab === "templates" && selectedTemplate && (
        <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)] max-md:grid-cols-1">
          <aside className="min-h-0 overflow-y-auto border-r border-[var(--line)] p-4 max-md:hidden">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">设定模板</h2>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  页面级 Markdown 初始结构
                </p>
              </div>
              <button
                type="button"
                onClick={createTemplate}
                aria-label="新建设定模板"
                title="新建设定模板"
                className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-warm)] text-white"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <CustomSelect
              value={groupFilter}
              options={[
                { value: "all", label: "全部分组" },
                ...groups.map((group) => ({ value: group, label: group })),
              ]}
              onChange={setGroupFilter}
            />
            <div className="mt-3 space-y-1">
              {draft.settingTemplates
                .filter(
                  (template) =>
                    groupFilter === "all" || template.group === groupFilter,
                )
                .map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(template.id)}
                    className={`w-full rounded-md px-3 py-2 text-left ${
                      selectedTemplate.id === template.id
                        ? "bg-[var(--accent-cool-subtle)]"
                        : "hover:bg-[var(--hover-bg)]"
                    }`}
                  >
                    <div className="truncate text-sm font-medium">
                      {template.name}
                      {template.archived && (
                        <span className="ml-1.5 rounded bg-[var(--paper-inset)] px-1 py-0.5 text-xs text-[var(--ink-muted)]">
                          已归档
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
                      {template.group} · v{template.version}
                    </div>
                  </button>
                ))}
            </div>
          </aside>
          <section className="min-h-0 overflow-y-auto px-7 pt-6 pb-24 max-md:px-4">
            <header className="flex items-start justify-between gap-4 border-b border-[var(--line-subtle)] pb-5">
              <div>
                <span className="text-xs text-[var(--ink-muted)]">
                  {selectedTemplate.source === "builtin"
                    ? "内置初始模板"
                    : "项目自定义"}{" "}
                  · v{selectedTemplate.version}
                  {selectedTemplate.archived && (
                    <span className="ml-1.5 rounded bg-[var(--paper-inset)] px-1 py-0.5">
                      已归档
                    </span>
                  )}
                </span>
                <h2 className="mt-1 text-xl font-semibold">
                  {selectedTemplate.name}
                </h2>
              </div>
              <div className="flex gap-2">
                {onAiAssist && (
                  <button
                    type="button"
                    onClick={() =>
                      onAiAssist(
                        {
                          kind: "setting-template",
                          label: `生成模板“${selectedTemplate.name}”`,
                          entityId: selectedTemplate.id,
                        },
                        { metaDraft: draft },
                      )
                    }
                    className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-2.5 text-sm text-[var(--accent-cool)]"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> AI 生成
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setPreviewTemplate(selectedTemplate)}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm"
                >
                  <Eye className="h-3.5 w-3.5" /> 预览
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) =>
                      replaceTemplate(
                        current,
                        selectedTemplate.id,
                        (template) => ({
                          ...template,
                          archived: !template.archived,
                        }),
                      ),
                    )
                  }
                  title={
                    selectedTemplate.archived
                      ? "恢复后，该模板会重新作为默认虚拟页面出现"
                      : "归档后，该模板不再为未落盘节点生成虚拟页面；已落盘页面保留"
                  }
                  className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm ${
                    selectedTemplate.archived
                      ? "border-[var(--line)]"
                      : "border-[var(--line)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  {selectedTemplate.archived ? (
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  ) : (
                    <Archive className="h-3.5 w-3.5" />
                  )}
                  {selectedTemplate.archived ? "恢复" : "归档"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = uniqueId("template");
                    const copy: SettingTemplate = {
                      ...selectedTemplate,
                      id,
                      name: `${selectedTemplate.name}副本`,
                      source: "project",
                      version: "1.0.0",
                    };
                    setDraft((current) => ({
                      ...current,
                      settingTemplates: [...current.settingTemplates, copy],
                    }));
                    setSelectedTemplateId(id);
                  }}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm"
                >
                  <Copy className="h-3.5 w-3.5" /> 复制
                </button>
              </div>
            </header>
            <div className="grid max-w-4xl grid-cols-2 gap-5 py-6 max-md:grid-cols-1">
              <label className="text-sm">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  模板名称
                </span>
                <input
                  value={selectedTemplate.name}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceTemplate(
                        current,
                        selectedTemplate.id,
                        (template) => ({
                          ...template,
                          name: event.target.value,
                        }),
                      ),
                    )
                  }
                  className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 outline-none"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  分组
                </span>
                <CustomSelect
                  value={selectedTemplate.group}
                  options={[
                    ...new Set([...groups, selectedTemplate.group]),
                  ].map((group) => ({
                    value: group,
                    label: group,
                  }))}
                  onChange={(value) =>
                    setDraft((current) =>
                      replaceTemplate(
                        current,
                        selectedTemplate.id,
                        (template) => ({
                          ...template,
                          group: value,
                        }),
                      ),
                    )
                  }
                />
              </label>
              <label className="col-span-2 text-sm max-md:col-span-1">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  说明
                </span>
                <input
                  value={selectedTemplate.description}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceTemplate(
                        current,
                        selectedTemplate.id,
                        (template) => ({
                          ...template,
                          description: event.target.value,
                        }),
                      ),
                    )
                  }
                  className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 outline-none"
                />
              </label>
              <label className="col-span-2 text-sm max-md:col-span-1">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  Markdown 初始骨架
                </span>
                <textarea
                  rows={13}
                  spellCheck={false}
                  value={selectedTemplate.skeleton}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceTemplate(
                        current,
                        selectedTemplate.id,
                        (template) => ({
                          ...template,
                          skeleton: event.target.value,
                        }),
                      ),
                    )
                  }
                  className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 font-mono text-sm leading-6 outline-none"
                />
              </label>
              <label className="col-span-2 text-sm max-md:col-span-1">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  Agent 引导
                </span>
                <textarea
                  rows={4}
                  value={selectedTemplate.agentGuide}
                  onChange={(event) =>
                    setDraft((current) =>
                      replaceTemplate(
                        current,
                        selectedTemplate.id,
                        (template) => ({
                          ...template,
                          agentGuide: event.target.value,
                        }),
                      ),
                    )
                  }
                  className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 outline-none"
                />
              </label>
            </div>
            <div className="flex items-center gap-2 border-t border-[var(--line-subtle)] pt-4 text-xs text-[var(--ink-muted)]">
              <History className="h-4 w-4" />{" "}
              编辑模板会自动递增版本号；新版本只影响未填写的虚拟页面，不覆盖已有正文。
            </div>
          </section>
        </div>
      )}

      {tab === "profiles" && (
        <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(28rem,1fr)_18rem] max-xl:grid-cols-[15rem_minmax(0,1fr)] max-md:grid-cols-1">
          <aside className="min-h-0 overflow-y-auto border-r border-[var(--line)] p-4 max-md:hidden">
            <h2 className="text-sm font-semibold">选择层级类型</h2>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              配置新节点的默认设定起点
            </p>
            <div className="mt-4 space-y-1">
              {draft.levelTypes.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => setProfileTypeId(type.id)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm ${
                    profileTypeId === type.id
                      ? "bg-[var(--accent-cool-subtle)] font-medium"
                      : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <span>{type.name}</span>
                  <span className="text-xs">
                    {draft.profiles.find(
                      (profile) => profile.levelTypeId === type.id,
                    )?.templateIds.length ?? 0}
                  </span>
                </button>
              ))}
            </div>
          </aside>
          <section className="min-h-0 overflow-y-auto border-r border-[var(--line)] px-6 pt-5 pb-24 max-xl:border-r-0 max-md:px-4">
            <header className="flex items-start justify-between gap-3 border-b border-[var(--line-subtle)] pb-4">
              <div>
                <div className="text-xs text-[var(--ink-muted)]">
                  LevelTypeSettingProfile
                </div>
                <h2 className="mt-1 text-lg font-semibold">
                  {draft.levelTypes.find((type) => type.id === profileTypeId)
                    ?.name ?? "层级类型"}{" "}
                  · 默认模板
                </h2>
              </div>
              {onAiAssist && (
                <button
                  type="button"
                  onClick={() =>
                    onAiAssist(
                      {
                        kind: "profile",
                        label: `推荐“${draft.levelTypes.find((type) => type.id === profileTypeId)?.name ?? "层级类型"}”的默认模板`,
                        entityId: profileTypeId,
                      },
                      { metaDraft: draft },
                    )
                  }
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--accent-cool)] bg-[var(--accent-cool-subtle)] px-2.5 text-sm text-[var(--accent-cool)]"
                >
                  <Sparkles className="h-3.5 w-3.5" /> AI 推荐关联
                </button>
              )}
            </header>
            <div className="my-4 flex gap-2 rounded-md bg-[var(--accent-cool-subtle)] px-3 py-2.5 text-xs text-[var(--ink-muted)]">
              <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
              <span>
                <strong className="text-[var(--ink)]">
                  默认模板不是限制。
                </strong>
                任何节点仍可新增任意自定义设定，移除关联也不会删除已填写正文。
              </span>
            </div>
            <div className="divide-y divide-[var(--line-subtle)] border-y border-[var(--line-subtle)]">
              {draft.settingTemplates.map((template) => {
                const profile = draft.profiles.find(
                  (item) => item.levelTypeId === profileTypeId,
                );
                const templateIds = profile?.templateIds ?? [];
                const checked = templateIds.includes(template.id);
                const index = templateIds.indexOf(template.id);
                return (
                  <div
                    key={template.id}
                    className="grid grid-cols-[2.5rem_minmax(0,1fr)_5rem] items-center gap-3 py-3"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      aria-label={`${template.name}默认模板`}
                      onChange={() =>
                        setDraft((current) => {
                          const existing = current.profiles.find(
                            (item) => item.levelTypeId === profileTypeId,
                          ) ?? { levelTypeId: profileTypeId, templateIds: [] };
                          const nextIds = checked
                            ? existing.templateIds.filter(
                                (id) => id !== template.id,
                              )
                            : [...existing.templateIds, template.id];
                          return {
                            ...current,
                            profiles: [
                              ...current.profiles.filter(
                                (item) => item.levelTypeId !== profileTypeId,
                              ),
                              { ...existing, templateIds: nextIds },
                            ],
                          };
                        })
                      }
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {template.name}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        {template.group}
                      </div>
                    </div>
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        disabled={!checked || index === 0}
                        aria-label={`上移${template.name}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            profiles: current.profiles.map((item) =>
                              item.levelTypeId === profileTypeId
                                ? {
                                    ...item,
                                    templateIds: moveItem(
                                      item.templateIds,
                                      index,
                                      -1,
                                    ),
                                  }
                                : item,
                            ),
                          }))
                        }
                        className="flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--hover-bg)] disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={!checked || index === templateIds.length - 1}
                        aria-label={`下移${template.name}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            profiles: current.profiles.map((item) =>
                              item.levelTypeId === profileTypeId
                                ? {
                                    ...item,
                                    templateIds: moveItem(
                                      item.templateIds,
                                      index,
                                      1,
                                    ),
                                  }
                                : item,
                            ),
                          }))
                        }
                        className="flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--hover-bg)] disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <aside className="min-h-0 overflow-y-auto p-5 max-xl:hidden">
            <div className="text-xs text-[var(--ink-muted)]">即时预览</div>
            <h2 className="mt-1 text-sm font-semibold">新建节点将出现</h2>
            <div className="mt-4 rounded-md border border-[var(--line)] bg-[var(--paper-inset)] p-3 text-sm font-medium">
              未命名
              {draft.levelTypes.find((type) => type.id === profileTypeId)?.name}
            </div>
            <ol className="mt-3 space-y-2">
              {(
                draft.profiles.find(
                  (profile) => profile.levelTypeId === profileTypeId,
                )?.templateIds ?? []
              ).map((templateId, index) => (
                <li
                  key={templateId}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="text-xs text-[var(--ink-subtle)]">
                    {index + 1}
                  </span>
                  <span>
                    {
                      draft.settingTemplates.find(
                        (item) => item.id === templateId,
                      )?.name
                    }
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-5 text-xs leading-5 text-[var(--ink-muted)]">
              首次编辑某页时才创建对应 Markdown 文件。
            </p>
          </aside>
        </div>
      )}
      {previewTemplate && (
        <PreviewDialog
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
        />
      )}
    </div>
  );
}
