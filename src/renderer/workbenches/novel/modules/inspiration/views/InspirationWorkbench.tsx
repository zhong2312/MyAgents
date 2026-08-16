import {
  Check,
  GitBranch,
  GitBranchPlus,
  Inbox,
  LayoutGrid,
  Lightbulb,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { DomainEntityRef } from "../../../shared/business/domainIndex";
import InspirationCanvas from "./InspirationCanvas";

import {
  OverlayBackdrop,
  useCloseLayer,
  type WorkbenchStorage,
  type WorkbenchNavigationGuard,
} from "@/workbench-sdk";

import { type InspirationAiAgentRequest } from "../business/inspirationAi";
import InspirationAiAssistant from "./InspirationAiAssistant";
import InspirationHelp from "./InspirationHelp";
import type {
  InspirationItem,
  InspirationLibrary,
} from "../entities/inspirationSchema";
import NarrativeMarkdownField from "../../../NarrativeMarkdownField";
import NarrativeSelect from "../../../NarrativeSelect";
import NarrativeUnsavedChangesGuard from "../../../NarrativeUnsavedChangesGuard";

type InspirationFilter = "all" | "inbox" | "organizing" | "unused" | "archived";

interface InspirationWorkbenchProps {
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
  readonly projectTitle: string;
  readonly library: InspirationLibrary;
  readonly content: string;
  readonly isSaving: boolean;
  readonly onSave: (value: InspirationLibrary) => Promise<void>;
  readonly onOpenAiAgent?: (
    request: InspirationAiAgentRequest,
  ) => Promise<void>;
  readonly onConvertToNarrative?: (item: InspirationItem) => Promise<void>;
  /** 外部实体定位请求（T3 消费：自动选中对应灵感）。 */
  readonly focus?: DomainEntityRef | null;
  readonly quickCreateRequest?: {
    readonly kind: "inspiration";
    readonly token: number;
  };
  readonly registerNavigationGuard: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
}

const FILTERS: readonly {
  readonly id: InspirationFilter;
  readonly label: string;
}[] = [
  { id: "all", label: "全部灵感" },
  { id: "inbox", label: "收集箱" },
  { id: "organizing", label: "待整理" },
  { id: "unused", label: "暂不使用" },
  { id: "archived", label: "已归档" },
];

const STATE_LABELS: Readonly<Record<InspirationItem["state"], string>> = {
  inbox: "收集箱",
  organizing: "待整理",
  unused: "暂不使用",
  archived: "已归档",
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="ns-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function createInspiration(
  title: string,
  body: string,
  sourceKind: InspirationItem["source"]["kind"],
): InspirationItem {
  const now = new Date().toISOString();
  return {
    id: createId("inspiration"),
    title: title.trim(),
    body,
    state: "inbox",
    source: {
      kind: sourceKind,
      label:
        sourceKind === "myagents-thought"
          ? "来自 MyAgents 想法"
          : sourceKind === "research"
            ? "研究记录"
            : sourceKind === "web"
              ? "网页摘录"
              : sourceKind === "other"
                ? "其它来源"
                : "随手记录",
      uri: "",
    },
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

function CreateInspirationDialog({
  onClose,
  onCreate,
}: {
  readonly onClose: () => void;
  readonly onCreate: (item: InspirationItem) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceKind, setSourceKind] =
    useState<InspirationItem["source"]["kind"]>("manual");
  const [maximized, setMaximized] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 90);

  return (
    <OverlayBackdrop className="z-[90]" onClose={onClose}>
      <form
        className={`ns-dialog ${maximized ? "is-maximized" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(createInspiration(title, body, sourceKind));
        }}
      >
        <header className="ns-dialog-header">
          <Lightbulb className="h-4 w-4 text-[var(--accent-warm)]" />
          <h2>记录灵感</h2>
          <button
            className="ns-icon-button ml-auto"
            type="button"
            title={maximized ? "恢复窗口" : "最大化弹窗"}
            aria-label={maximized ? "恢复窗口" : "最大化弹窗"}
            onClick={() => setMaximized((current) => !current)}
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            className="ns-icon-button"
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="ns-dialog-body">
          <Field label="标题">
            <input
              autoFocus
              className="ns-input"
              value={title}
              placeholder="一句能重新唤起这个想法的话"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="正文">
            <NarrativeMarkdownField
              pageId="inspiration.create.body"
              label="灵感正文"
              value={body}
              placeholder="片段、意象、问题、场景或研究触发点"
              onChange={setBody}
            />
          </Field>
          <Field label="来源">
            <NarrativeSelect
              className="ns-select"
              value={sourceKind}
              onChange={(event) =>
                setSourceKind(
                  event.target.value as InspirationItem["source"]["kind"],
                )
              }
            >
              <option value="manual">随手记录</option>
              <option value="myagents-thought">MyAgents 想法</option>
              <option value="research">研究记录</option>
              <option value="web">网页摘录</option>
              <option value="other">其它来源</option>
            </NarrativeSelect>
          </Field>
        </div>
        <footer className="ns-dialog-footer">
          <button className="ns-button" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="ns-button is-primary"
            type="submit"
            disabled={!title.trim()}
          >
            记录
          </button>
        </footer>
      </form>
    </OverlayBackdrop>
  );
}

export default function InspirationWorkbench({
  storage,
  isActive,
  projectTitle,
  library,
  content,
  isSaving,
  onSave,
  onOpenAiAgent,
  onConvertToNarrative,
  focus,
  quickCreateRequest,
  registerNavigationGuard,
}: InspirationWorkbenchProps) {
  const [draft, setDraft] = useState(library);
  const [baselineContent, setBaselineContent] = useState(content);
  const [dirty, setDirty] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [filter, setFilter] = useState<InspirationFilter>("all");
  const [view, setView] = useState<"list" | "board" | "canvas">("list");
  const [sort, setSort] = useState<"updated" | "source">("updated");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(library.items[0]?.id ?? "");
  const [mobilePane, setMobilePane] = useState<
    "structure" | "content" | "detail"
  >("content");
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!isActive || quickCreateRequest?.kind !== "inspiration") return;
    setCreateOpen(true);
  }, [isActive, quickCreateRequest]);

  useEffect(() => {
    if (content === baselineContent) return;
    const timer = window.setTimeout(() => {
      setBaselineContent(content);
      if (dirty) setExternalChanged(true);
      else setDraft(library);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [baselineContent, content, dirty, library]);

  useEffect(() => {
    if (selectedId || !draft.items[0]) return;
    const timer = window.setTimeout(() => {
      setSelectedId(draft.items[0]?.id ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draft.items, selectedId]);

  const updateDraft = (next: InspirationLibrary) => {
    setDraft(next);
    setDirty(true);
    setSaveError(null);
  };
  const selected = draft.items.find((item) => item.id === selectedId);
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const visibleItems = draft.items
    .filter((item) => {
      if (filter !== "all" && item.state !== filter) return false;
      return (
        !normalizedSearch ||
        `${item.title} ${item.body} ${item.tags.join(" ")}`
          .toLocaleLowerCase("zh-CN")
          .includes(normalizedSearch)
      );
    })
    .sort((left, right) =>
      sort === "source"
        ? left.source.label.localeCompare(right.source.label, "zh-CN") ||
          right.updatedAt.localeCompare(left.updatedAt)
        : right.updatedAt.localeCompare(left.updatedAt),
    );

  const count = (id: InspirationFilter) =>
    id === "all"
      ? draft.items.length
      : draft.items.filter((item) => item.state === id).length;

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    if (isSaving) return false;
    setSaveError(null);
    try {
      await onSave(draft);
      setDirty(false);
      setExternalChanged(false);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const updateItem = (patch: Partial<InspirationItem>) => {
    if (!selected) return;
    updateDraft({
      ...draft,
      items: draft.items.map((item) =>
        item.id === selected.id
          ? { ...item, ...patch, updatedAt: new Date().toISOString() }
          : item,
      ),
    });
  };

  const selectItem = useCallback((id: string) => {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 1100px)").matches) {
      setMobilePane("detail");
    }
  }, []);

  // 外部实体定位：焦点灵感存在时自动选中（T3）
  useEffect(() => {
    if (!focus || focus.kind !== "inspiration") return;
    if (draft.items.some((item) => item.id === focus.id)) {
      selectItem(focus.id);
    }
  }, [focus, draft.items, selectItem]);

  const removeSelected = () => {
    if (!selected || !window.confirm(`确认删除灵感“${selected.title}”？`))
      return;
    updateDraft({
      ...draft,
      items: draft.items.filter((item) => item.id !== selected.id),
    });
    setSelectedId(
      draft.items.find((item) => item.id !== selected.id)?.id ?? "",
    );
  };

  const [converting, setConverting] = useState(false);
  const [convertNotice, setConvertNotice] = useState<string | null>(null);
  const convertToNarrative = async () => {
    if (!selected || !onConvertToNarrative || converting) return;
    setConverting(true);
    setConvertNotice(null);
    try {
      await onConvertToNarrative(selected);
      setConvertNotice(`“${selected.title}”已转为剧情规划，可在剧情工程查看。`);
    } catch (cause) {
      setConvertNotice(
        `转为剧情规划失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setConverting(false);
    }
  };

  const boardColumns = FILTERS.filter(
    (
      item,
    ): item is (typeof FILTERS)[number] & {
      id: Exclude<InspirationFilter, "all">;
    } => item.id !== "all",
  );
  const filterLabel =
    FILTERS.find((item) => item.id === filter)?.label ?? "灵感";
  const aiContext = {
    projectTitle,
    focusId: selected?.id ?? `filter:${filter}`,
    focusLabel: selected?.title ?? filterLabel,
  };

  return (
    <div className="inspiration-studio" data-mobile-pane={mobilePane}>
      <NarrativeUnsavedChangesGuard
        dirty={dirty}
        label="灵感"
        registerNavigationGuard={registerNavigationGuard}
        onSave={save}
      />
      <header className="ns-header">
        <h1 className="ns-title">灵感</h1>
        <InspirationHelp />
        <InspirationAiAssistant
          context={aiContext}
          onOpenAgent={onOpenAiAgent}
        />
        <span className="ns-subtitle">记录、整理与归档创作素材</span>
        <span className="ns-header-spacer" />
        <label className="ns-search">
          <Search className="h-3.5 w-3.5" />
          <input
            value={search}
            placeholder="搜索灵感"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          className="ns-icon-button ns-detail-toggle"
          type="button"
          title="打开灵感详情"
          aria-label="打开灵感详情"
          onClick={() => setMobilePane("detail")}
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <div className="flex rounded-md border border-[var(--line)] bg-[var(--paper)] p-0.5">
          <button
            className={`ns-icon-button border-0 ${view === "list" ? "bg-[var(--hover-bg)] text-[var(--ink)]" : ""}`}
            type="button"
            title="列表视图"
            aria-label="列表视图"
            onClick={() => setView("list")}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            className={`ns-icon-button border-0 ${view === "board" ? "bg-[var(--hover-bg)] text-[var(--ink)]" : ""}`}
            type="button"
            title="看板视图"
            aria-label="看板视图"
            onClick={() => setView("board")}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            className={`ns-icon-button border-0 ${view === "canvas" ? "bg-[var(--hover-bg)] text-[var(--ink)]" : ""}`}
            type="button"
            title="画布视图"
            aria-label="画布视图"
            onClick={() => setView("canvas")}
          >
            <GitBranch className="h-4 w-4" />
          </button>
        </div>
        <button
          className="ns-button"
          type="button"
          disabled={!dirty || isSaving}
          onClick={() => void save()}
        >
          {isSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : dirty ? (
            <Save className="h-3.5 w-3.5" />
          ) : (
            <Check className="h-3.5 w-3.5 text-[var(--success)]" />
          )}
          {isSaving ? "保存中" : dirty ? "保存" : "已保存"}
        </button>
        <button
          className="ns-button is-primary"
          type="button"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          记录
        </button>
      </header>
      {(saveError || externalChanged) && (
        <div className="ns-warning-banner">
          <RefreshCw className="h-4 w-4" />
          <span>{saveError ?? "灵感文件已在外部修改，本地草稿未被覆盖"}</span>
          {externalChanged && (
            <button
              className="ns-button ml-auto"
              type="button"
              onClick={() => {
                setDraft(library);
                setDirty(false);
                setExternalChanged(false);
                setSaveError(null);
              }}
            >
              载入磁盘版本
            </button>
          )}
        </div>
      )}
      <div className="ns-mobile-tabs">
        <button
          className={`ns-segment-button ${mobilePane === "structure" ? "is-active" : ""}`}
          type="button"
          onClick={() => setMobilePane("structure")}
        >
          分类
        </button>
        <button
          className={`ns-segment-button ${mobilePane === "content" ? "is-active" : ""}`}
          type="button"
          onClick={() => setMobilePane("content")}
        >
          灵感
        </button>
        <button
          className={`ns-segment-button ${mobilePane === "detail" ? "is-active" : ""}`}
          type="button"
          onClick={() => setMobilePane("detail")}
        >
          详情
        </button>
      </div>
      <div className="ns-workspace">
        <aside className="ns-pane ns-tree-pane">
          <div className="ns-pane-header">
            <Inbox className="h-4 w-4 text-[var(--accent-warm)]" />
            <strong>灵感库</strong>
          </div>
          <div className="ns-filter-list">
            {FILTERS.map((item) => (
              <button
                className={`ns-filter-row ${filter === item.id ? "is-active" : ""}`}
                type="button"
                key={item.id}
                onClick={() => {
                  setFilter(item.id);
                  setMobilePane("content");
                }}
              >
                <span className="ns-tree-label">{item.label}</span>
                <span className="ns-count">{count(item.id)}</span>
              </button>
            ))}
          </div>
          <div className="ns-tree-note">
            项目灵感保存独立副本；来源只用于追溯，不依赖全局 Thought 存储。
          </div>
        </aside>
        <main className="ns-pane ns-content-pane">
          <div className="ns-content-toolbar">
            <strong>{filterLabel}</strong>
            <span className="ns-pane-meta">{visibleItems.length} 条</span>
            <span className="ns-header-spacer" />
            <NarrativeSelect
              className="ns-select max-w-36"
              aria-label="灵感排序"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="updated">最近更新</option>
              <option value="source">按来源</option>
            </NarrativeSelect>
          </div>
          {visibleItems.length === 0 ? (
            <div className="ns-empty">
              <div>
                <Lightbulb className="mx-auto h-5 w-5" />
                <strong className="mt-3">当前视图没有灵感</strong>
                <p>记录片段、意象、问题、场景、人设火花或研究触发点。</p>
              </div>
            </div>
          ) : view === "canvas" ? (
            <InspirationCanvas
              storage={storage}
              projectTitle={projectTitle}
              isActive={isActive}
            />
          ) : view === "list" ? (
            <div className="ns-list">
              {visibleItems.map((item) => (
                <button
                  className={`ns-list-row ${selectedId === item.id ? "is-active" : ""}`}
                  type="button"
                  key={item.id}
                  onClick={() => selectItem(item.id)}
                >
                  <span className="ns-list-title">{item.title}</span>
                  <span className="ns-badge">{STATE_LABELS[item.state]}</span>
                  <span className="ns-list-summary">
                    {item.body || "暂无正文"} ·{" "}
                    {item.tags.join("、") || item.source.label}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="ns-content-scroll">
              <div className="ns-kanban">
                {boardColumns.map((column) => {
                  const items = draft.items
                    .filter((item) => item.state === column.id)
                    .filter(
                      (item) =>
                        !normalizedSearch ||
                        `${item.title} ${item.body}`
                          .toLocaleLowerCase("zh-CN")
                          .includes(normalizedSearch),
                    );
                  return (
                    <section className="ns-kanban-column" key={column.id}>
                      <header className="ns-kanban-header">
                        <span>{column.label}</span>
                        <span className="ns-count">{items.length}</span>
                      </header>
                      {items.map((item) => (
                        <button
                          className={`ns-kanban-card ${selectedId === item.id ? "is-active" : ""}`}
                          type="button"
                          key={item.id}
                          onClick={() => selectItem(item.id)}
                        >
                          <strong className="text-xs">{item.title}</strong>
                          <p className="mt-1 line-clamp-3 text-xs leading-5 text-[var(--ink-muted)]">
                            {item.body || "暂无正文"}
                          </p>
                        </button>
                      ))}
                    </section>
                  );
                })}
              </div>
            </div>
          )}
        </main>
        <aside className="ns-pane ns-inspector-pane">
          <div className="ns-pane-header">
            <Sparkles className="h-4 w-4 text-[var(--accent-warm)]" />
            <strong>灵感详情</strong>
            {selected && (
              <span className="ml-auto ns-badge">
                {STATE_LABELS[selected.state]}
              </span>
            )}
            <button
              className="ns-icon-button ns-detail-close"
              type="button"
              title="关闭灵感详情"
              aria-label="关闭灵感详情"
              onClick={() => setMobilePane("content")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {!selected ? (
            <div className="ns-empty">请选择一条灵感</div>
          ) : (
            <div className="ns-inspector-body">
              <div className="ns-kicker">项目灵感</div>
              <h2 className="ns-object-title">{selected.title}</h2>
              <section className="ns-section">
                <Field label="标题">
                  <input
                    className="ns-input"
                    value={selected.title}
                    onChange={(event) =>
                      updateItem({ title: event.target.value })
                    }
                  />
                </Field>
                <Field label="整理状态">
                  <NarrativeSelect
                    className="ns-select"
                    value={selected.state}
                    onChange={(event) =>
                      updateItem({
                        state: event.target.value as InspirationItem["state"],
                      })
                    }
                  >
                    <option value="inbox">收集箱</option>
                    <option value="organizing">待整理</option>
                    <option value="unused">暂不使用</option>
                    <option value="archived">已归档</option>
                  </NarrativeSelect>
                </Field>
                <Field label="正文">
                  <NarrativeMarkdownField
                    pageId={`inspiration.${selected.id}.body`}
                    label="灵感正文"
                    value={selected.body}
                    onChange={(body) => updateItem({ body })}
                  />
                </Field>
                <Field label="标签（逗号分隔）">
                  <input
                    className="ns-input"
                    value={selected.tags.join("，")}
                    onChange={(event) =>
                      updateItem({
                        tags: event.target.value
                          .split(/[，,]/u)
                          .map((tag) => tag.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              </section>
              <section className="ns-section">
                <div className="ns-section-header">来源</div>
                <div className="ns-source-row">
                  <strong>{selected.source.label}</strong>
                  <div>
                    {selected.source.kind === "myagents-thought"
                      ? "已复制为当前小说的项目素材，不依赖全局 Thought 存储。"
                      : selected.source.uri || "项目内记录"}
                  </div>
                </div>
              </section>
              <section className="ns-section">
                {convertNotice && (
                  <div className="mb-2 rounded-md bg-[var(--accent-cool-subtle)] px-3 py-2 text-xs leading-5 text-[var(--accent-cool)]">
                    {convertNotice}
                  </div>
                )}
                <button
                  className="ns-button"
                  type="button"
                  onClick={() => void convertToNarrative()}
                  disabled={!onConvertToNarrative || converting}
                  title="把这条灵感转为剧情工程的章节规划"
                >
                  {converting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <GitBranchPlus className="h-3.5 w-3.5" />
                  )}
                  转为剧情规划
                </button>
                <button
                  className="ns-button is-danger"
                  type="button"
                  onClick={removeSelected}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除灵感
                </button>
              </section>
            </div>
          )}
        </aside>
      </div>
      {createOpen && (
        <CreateInspirationDialog
          onClose={() => setCreateOpen(false)}
          onCreate={(item) => {
            updateDraft({ ...draft, items: [item, ...draft.items] });
            setSelectedId(item.id);
            setCreateOpen(false);
            setMobilePane("detail");
          }}
        />
      )}
    </div>
  );
}
