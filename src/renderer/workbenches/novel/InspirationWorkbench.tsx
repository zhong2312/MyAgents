import {
  Check,
  Inbox,
  LayoutGrid,
  Lightbulb,
  List,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  isInspirationAdopted,
  resolveCreativeProfile,
  type CreativeProfile,
  type InspirationAdoption,
  type InspirationItem,
  type InspirationLibrary,
  type NarrativeDesign,
  type NarrativeObjectKind,
} from "./narrativeStudioSchema";
import type { NarrativeFocus } from "./NarrativeDesignWorkbench";
import NarrativeSelect from "./NarrativeSelect";

type InspirationFilter =
  | "all"
  | "inbox"
  | "organizing"
  | "adopted"
  | "unused"
  | "archived";

interface InspirationWorkbenchProps {
  readonly library: InspirationLibrary;
  readonly content: string;
  readonly narrative: NarrativeDesign;
  readonly profile: CreativeProfile;
  readonly isSaving: boolean;
  readonly focusId: string | null;
  readonly onFocusConsumed: () => void;
  readonly onSave: (value: InspirationLibrary) => Promise<void>;
  readonly onOpenNarrative: (focus: NarrativeFocus) => void;
}

const FILTERS: readonly { readonly id: InspirationFilter; readonly label: string }[] = [
  { id: "all", label: "全部灵感" },
  { id: "inbox", label: "收集箱" },
  { id: "organizing", label: "待整理" },
  { id: "adopted", label: "已采用" },
  { id: "unused", label: "未采用" },
  { id: "archived", label: "已归档" },
];

const STATE_LABELS: Readonly<Record<InspirationItem["state"], string>> = {
  inbox: "收集箱",
  organizing: "待整理",
  unused: "未采用",
  archived: "已归档",
};

const OBJECT_LABELS: Readonly<Record<NarrativeObjectKind, string>> = {
  structure: "结构单元",
  thread: "叙事线路",
  arc: "故事弧",
  node: "叙事节点",
  expectation: "期待",
  "chapter-plan": "章节计划",
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="ns-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function createInspiration(title: string, body: string, sourceKind: InspirationItem["source"]["kind"]): InspirationItem {
  const now = new Date().toISOString();
  return {
    id: createId("inspiration"),
    title: title.trim(),
    body,
    typeId: "idea.fragment",
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
  const [sourceKind, setSourceKind] = useState<InspirationItem["source"]["kind"]>("manual");
  return (
    <div className="ns-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="ns-dialog" onSubmit={(event) => { event.preventDefault(); onCreate(createInspiration(title, body, sourceKind)); }}>
        <header className="ns-dialog-header">
          <Lightbulb className="h-4 w-4 text-[var(--accent-warm)]" />
          <h2>记录灵感</h2>
          <button className="ns-icon-button ml-auto" type="button" title="关闭" aria-label="关闭" onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        <div className="ns-dialog-body">
          <Field label="标题"><input autoFocus className="ns-input" value={title} placeholder="一句能重新唤起这个想法的话" onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field label="正文"><textarea className="ns-textarea min-h-36" value={body} placeholder="片段、意象、问题、场景或研究触发点" onChange={(event) => setBody(event.target.value)} /></Field>
          <Field label="来源"><NarrativeSelect className="ns-select" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as InspirationItem["source"]["kind"])}><option value="manual">随手记录</option><option value="myagents-thought">MyAgents 想法</option><option value="research">研究记录</option><option value="web">网页摘录</option><option value="other">其它来源</option></NarrativeSelect></Field>
        </div>
        <footer className="ns-dialog-footer"><button className="ns-button" type="button" onClick={onClose}>取消</button><button className="ns-button is-primary" type="submit" disabled={!title.trim()}>记录</button></footer>
      </form>
    </div>
  );
}

interface AdoptionTarget {
  readonly kind: NarrativeObjectKind;
  readonly id: string;
  readonly label: string;
}

function AdoptionDialog({
  inspiration,
  narrative,
  profile,
  onClose,
  onConfirm,
}: {
  readonly inspiration: InspirationItem;
  readonly narrative: NarrativeDesign;
  readonly profile: CreativeProfile;
  readonly onClose: () => void;
  readonly onConfirm: (adoption: InspirationAdoption) => void;
}) {
  const targets: readonly AdoptionTarget[] = [
    ...narrative.structures.map((item) => ({ kind: "structure" as const, id: item.id, label: item.title })),
    ...narrative.threads.map((item) => ({ kind: "thread" as const, id: item.id, label: item.title })),
    ...narrative.arcs.map((item) => ({ kind: "arc" as const, id: item.id, label: item.title })),
    ...narrative.nodes.map((item) => ({ kind: "node" as const, id: item.id, label: item.title })),
    ...narrative.expectations.map((item) => ({ kind: "expectation" as const, id: item.id, label: item.title })),
    ...narrative.chapterPlans.map((item) => ({ kind: "chapter-plan" as const, id: item.id, label: item.title })),
  ];
  const resolved = resolveCreativeProfile(profile);
  const adoptionTypes = resolved.definitions.filter(
    (item) => item.category === "object-type" || item.category === "relation",
  );
  const [targetKey, setTargetKey] = useState(targets[0] ? `${targets[0].kind}:${targets[0].id}` : "");
  const [typeId, setTypeId] = useState(adoptionTypes[0]?.id ?? "core.situation");
  const [note, setNote] = useState("");
  const target = targets.find((item) => `${item.kind}:${item.id}` === targetKey);
  const adoptionType = adoptionTypes.find((item) => item.id === typeId);
  return (
    <div className="ns-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="ns-dialog" onSubmit={(event) => { event.preventDefault(); if (!target) return; onConfirm({ id: createId("adoption"), inspirationId: inspiration.id, targetKind: target.kind, targetId: target.id, targetLabel: target.label, adoptedTypeId: adoptionType?.id ?? typeId, adoptedTypeLabel: adoptionType?.name ?? typeId, note, createdAt: new Date().toISOString() }); }}>
        <header className="ns-dialog-header"><Sparkles className="h-4 w-4 text-[var(--accent-warm)]" /><h2>采用为项目对象</h2><button className="ns-icon-button ml-auto" type="button" title="关闭" aria-label="关闭" onClick={onClose}><X className="h-4 w-4" /></button></header>
        <div className="ns-dialog-body">
          <Field label="采用类型"><NarrativeSelect className="ns-select" value={typeId} onChange={(event) => setTypeId(event.target.value)}>{adoptionTypes.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.layerName}</option>)}</NarrativeSelect></Field>
          <Field label="关联目标"><NarrativeSelect className="ns-select" value={targetKey} onChange={(event) => setTargetKey(event.target.value)}>{targets.map((item) => <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>{OBJECT_LABELS[item.kind]} · {item.label}</option>)}</NarrativeSelect></Field>
          <Field label="采用说明"><textarea className="ns-textarea" value={note} placeholder="记录这个灵感将如何转化，不改写原始灵感" onChange={(event) => setNote(event.target.value)} /></Field>
          <div className="ns-relation-row mt-4"><strong>将创建 adopted-as 关系</strong><div>{inspiration.title} → {adoptionType?.name ?? typeId} → {target?.label ?? "未选择目标"}</div><div className="mt-1 text-[var(--ink-muted)]">确认后“已采用”将由这条关系自动推导，不需要额外修改状态。</div></div>
        </div>
        <footer className="ns-dialog-footer"><button className="ns-button" type="button" onClick={onClose}>取消</button><button className="ns-button is-primary" type="submit" disabled={!target || !typeId}>确认采用</button></footer>
      </form>
    </div>
  );
}

export default function InspirationWorkbench({
  library,
  content,
  narrative,
  profile,
  isSaving,
  focusId,
  onFocusConsumed,
  onSave,
  onOpenNarrative,
}: InspirationWorkbenchProps) {
  const [draft, setDraft] = useState(library);
  const [baselineContent, setBaselineContent] = useState(content);
  const [dirty, setDirty] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [filter, setFilter] = useState<InspirationFilter>("all");
  const [view, setView] = useState<"list" | "board">("list");
  const [sort, setSort] = useState<"updated" | "source" | "adoption">(
    "updated",
  );
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(library.items[0]?.id ?? "");
  const [mobilePane, setMobilePane] = useState<"structure" | "content" | "detail">("content");
  const [createOpen, setCreateOpen] = useState(false);
  const [adoptionOpen, setAdoptionOpen] = useState(false);

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
    if (!focusId) return;
    const timer = window.setTimeout(() => {
      setSelectedId(focusId);
      setMobilePane("detail");
      onFocusConsumed();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusId, onFocusConsumed]);

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
  const adoptedIds = useMemo(() => new Set(draft.adoptions.map((item) => item.inspirationId)), [draft.adoptions]);
  const inspirationTypes = useMemo(
    () =>
      resolveCreativeProfile(profile).definitions.filter(
        (item) =>
          item.category === "object-type" && item.scope === "inspiration",
      ),
    [profile],
  );
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const visibleItems = draft.items
    .filter((item) => {
      const adopted = adoptedIds.has(item.id);
      if (filter === "adopted" && !adopted) return false;
      if (filter === "inbox" && item.state !== "inbox") return false;
      if (filter === "organizing" && item.state !== "organizing") return false;
      if (filter === "unused" && (item.state !== "unused" || adopted)) return false;
      if (filter === "archived" && item.state !== "archived") return false;
      return !normalizedSearch || `${item.title} ${item.body} ${item.tags.join(" ")}`.toLocaleLowerCase("zh-CN").includes(normalizedSearch);
    })
    .sort((left, right) => {
      if (sort === "source") {
        return (
          left.source.label.localeCompare(right.source.label, "zh-CN") ||
          right.updatedAt.localeCompare(left.updatedAt)
        );
      }
      if (sort === "adoption") {
        return (
          Number(adoptedIds.has(right.id)) - Number(adoptedIds.has(left.id)) ||
          right.updatedAt.localeCompare(left.updatedAt)
        );
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });

  const count = (id: InspirationFilter) => {
    if (id === "all") return draft.items.length;
    if (id === "adopted") return adoptedIds.size;
    if (id === "unused") return draft.items.filter((item) => item.state === "unused" && !adoptedIds.has(item.id)).length;
    return draft.items.filter((item) => item.state === id).length;
  };

  const save = async () => {
    if (!dirty || isSaving) return;
    setSaveError(null);
    try {
      await onSave(draft);
      setDirty(false);
      setExternalChanged(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateItem = (patch: Partial<InspirationItem>) => {
    if (!selected) return;
    updateDraft({ ...draft, items: draft.items.map((item) => item.id === selected.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item) });
  };

  const selectItem = (id: string) => {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 720px)").matches) setMobilePane("detail");
  };

  const removeSelected = () => {
    if (!selected || !window.confirm(`确认删除灵感“${selected.title}”？它的采用记录也会被删除。`)) return;
    updateDraft({ ...draft, items: draft.items.filter((item) => item.id !== selected.id), adoptions: draft.adoptions.filter((item) => item.inspirationId !== selected.id) });
    setSelectedId(draft.items.find((item) => item.id !== selected.id)?.id ?? "");
  };

  const boardColumns: readonly { readonly id: InspirationFilter; readonly label: string }[] = [
    { id: "inbox", label: "收集箱" },
    { id: "organizing", label: "待整理" },
    { id: "adopted", label: "已采用" },
    { id: "unused", label: "未采用" },
    { id: "archived", label: "已归档" },
  ];

  return (
    <div className="narrative-studio" data-mobile-pane={mobilePane}>
      <header className="ns-header">
        <h1 className="ns-title">灵感</h1>
        <span className="ns-subtitle">采用状态由关系自动推导</span>
        <span className="ns-header-spacer" />
        <label className="ns-search"><Search className="h-3.5 w-3.5" /><input value={search} placeholder="搜索灵感" onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="flex rounded-md border border-[var(--line)] bg-[var(--paper)] p-0.5"><button className={`ns-icon-button border-0 ${view === "list" ? "bg-[var(--hover-bg)] text-[var(--ink)]" : ""}`} type="button" title="列表视图" onClick={() => setView("list")}><List className="h-4 w-4" /></button><button className={`ns-icon-button border-0 ${view === "board" ? "bg-[var(--hover-bg)] text-[var(--ink)]" : ""}`} type="button" title="看板视图" onClick={() => setView("board")}><LayoutGrid className="h-4 w-4" /></button></div>
        <button className="ns-button" type="button" disabled={!dirty || isSaving} onClick={() => void save()}>{isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : dirty ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5 text-[var(--success)]" />}{isSaving ? "保存中" : dirty ? "保存" : "已保存"}</button>
        <button className="ns-button is-primary" type="button" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />记录</button>
      </header>
      {(saveError || externalChanged) && <div className="ns-warning-banner"><RefreshCw className="h-4 w-4" /><span>{saveError ?? "灵感文件已在外部修改，本地草稿未被覆盖"}</span>{externalChanged && <button className="ns-button ml-auto" type="button" onClick={() => { setDraft(library); setDirty(false); setExternalChanged(false); setSaveError(null); }}>载入磁盘版本</button>}</div>}
      <div className="ns-mobile-tabs"><button className={`ns-segment-button ${mobilePane === "structure" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("structure")}>分类</button><button className={`ns-segment-button ${mobilePane === "content" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("content")}>灵感</button><button className={`ns-segment-button ${mobilePane === "detail" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("detail")}>详情</button></div>
      <div className="ns-workspace">
        <aside className="ns-pane ns-tree-pane">
          <div className="ns-pane-header"><Inbox className="h-4 w-4 text-[var(--accent-warm)]" /><strong>灵感库</strong></div>
          <div className="ns-filter-list">{FILTERS.map((item) => <button className={`ns-filter-row ${filter === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => { setFilter(item.id); setMobilePane("content"); }}><span className="ns-tree-label">{item.label}</span><span className="ns-count">{count(item.id)}</span></button>)}</div>
          <div className="ns-tree-note">项目灵感保存独立副本；来自 MyAgents 想法的来源只用于追溯，不依赖全局 Thought 存储。</div>
        </aside>
        <main className="ns-pane ns-content-pane">
          <div className="ns-content-toolbar"><strong>{FILTERS.find((item) => item.id === filter)?.label}</strong><span className="ns-pane-meta">{visibleItems.length} 条</span><span className="ns-header-spacer" /><NarrativeSelect className="ns-select max-w-36" aria-label="灵感排序" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="updated">最近更新</option><option value="source">按来源</option><option value="adoption">已采用优先</option></NarrativeSelect></div>
          {visibleItems.length === 0 ? <div className="ns-empty"><div><Lightbulb className="mx-auto h-5 w-5" /><strong className="mt-3">当前视图没有灵感</strong><p>记录片段、意象、问题、场景、人设火花或研究触发点。</p></div></div> : view === "list" ? <div className="ns-list">{visibleItems.map((item) => <button className={`ns-list-row ${selectedId === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => selectItem(item.id)}><span className="ns-list-title">{item.title}</span><span className={`ns-badge ${adoptedIds.has(item.id) ? "is-success" : ""}`}>{adoptedIds.has(item.id) ? "已采用" : STATE_LABELS[item.state]}</span><span className="ns-list-summary">{item.body || "暂无正文"} · {item.tags.join("、") || item.source.label}</span></button>)}</div> : <div className="ns-content-scroll"><div className="ns-kanban">{boardColumns.map((column) => { const items = draft.items.filter((item) => column.id === "adopted" ? adoptedIds.has(item.id) : column.id === "unused" ? item.state === "unused" && !adoptedIds.has(item.id) : item.state === column.id).filter((item) => !normalizedSearch || `${item.title} ${item.body}`.toLocaleLowerCase("zh-CN").includes(normalizedSearch)); return <section className="ns-kanban-column" key={column.id}><header className="ns-kanban-header"><span>{column.label}</span><span className="ns-count">{items.length}</span></header>{items.map((item) => <button className={`ns-kanban-card ${selectedId === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => selectItem(item.id)}><strong className="text-xs">{item.title}</strong><p className="mt-1 line-clamp-3 text-[0.7rem] leading-5 text-[var(--ink-muted)]">{item.body || "暂无正文"}</p></button>)}</section>; })}</div></div>}
        </main>
        <aside className="ns-pane ns-inspector-pane">
          <div className="ns-pane-header"><Sparkles className="h-4 w-4 text-[var(--accent-warm)]" /><strong>灵感详情</strong>{selected && <span className="ml-auto ns-badge">{isInspirationAdopted(draft, selected.id) ? "已采用" : STATE_LABELS[selected.state]}</span>}</div>
          {!selected ? <div className="ns-empty">请选择一条灵感</div> : <div className="ns-inspector-body">
            <div className="ns-kicker">项目灵感</div>
            <h2 className="ns-object-title">{selected.title}</h2>
            <section className="ns-section">
              <Field label="标题"><input className="ns-input" value={selected.title} onChange={(event) => updateItem({ title: event.target.value })} /></Field>
              <div className="ns-field-grid"><Field label="灵感类型"><NarrativeSelect className="ns-select" value={selected.typeId} onChange={(event) => updateItem({ typeId: event.target.value })}>{!inspirationTypes.some((item) => item.id === selected.typeId) && <option value={selected.typeId}>保留类型</option>}{inspirationTypes.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.layerName}</option>)}</NarrativeSelect></Field><Field label="整理状态"><NarrativeSelect className="ns-select" value={selected.state} onChange={(event) => updateItem({ state: event.target.value as InspirationItem["state"] })}><option value="inbox">收集箱</option><option value="organizing">待整理</option><option value="unused">未采用</option><option value="archived">已归档</option></NarrativeSelect></Field></div>
              <Field label="正文"><textarea className="ns-textarea min-h-40" value={selected.body} onChange={(event) => updateItem({ body: event.target.value })} /></Field>
              <Field label="标签（逗号分隔）"><input className="ns-input" value={selected.tags.join("，")} onChange={(event) => updateItem({ tags: event.target.value.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean) })} /></Field>
            </section>
            <section className="ns-section"><div className="ns-section-header">来源</div><div className="ns-relation-row"><strong>{selected.source.label}</strong><div>{selected.source.kind === "myagents-thought" ? "已复制为当前小说的项目事实，不依赖全局 Thought 存储。" : selected.source.uri || "项目内记录"}</div></div></section>
            <section className="ns-section"><div className="ns-section-header">采用记录 · {draft.adoptions.filter((item) => item.inspirationId === selected.id).length}</div><div className="ns-relation-list">{draft.adoptions.filter((item) => item.inspirationId === selected.id).map((adoption) => <div className="ns-relation-row is-actual" key={adoption.id}><button className="w-full text-left" type="button" onClick={() => onOpenNarrative({ kind: adoption.targetKind, id: adoption.targetId })}><strong>{adoption.adoptedTypeLabel}</strong><div>关联 {OBJECT_LABELS[adoption.targetKind]} · {adoption.targetLabel}</div>{adoption.note && <div className="mt-1 text-[var(--ink-muted)]">{adoption.note}</div>}</button><div className="ns-row-actions is-end"><button className="ns-icon-button" type="button" title="移除采用关系" onClick={() => updateDraft({ ...draft, adoptions: draft.adoptions.filter((item) => item.id !== adoption.id) })}><Trash2 className="h-3.5 w-3.5" /></button></div></div>)}</div><button className="ns-button mt-2" type="button" disabled={!narrative.structures.length} onClick={() => setAdoptionOpen(true)}><Sparkles className="h-3.5 w-3.5" />{isInspirationAdopted(draft, selected.id) ? "继续采用" : "采用为"}</button>{isInspirationAdopted(draft, selected.id) && <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">同一灵感可以继续采用为场景、期待、人物火花或任何方案声明的对象。</p>}</section>
            <section className="ns-section"><button className="ns-button is-danger" type="button" onClick={removeSelected}><Trash2 className="h-3.5 w-3.5" />删除灵感</button></section>
          </div>}
        </aside>
      </div>
      {createOpen && <CreateInspirationDialog onClose={() => setCreateOpen(false)} onCreate={(item) => { const created = { ...item, typeId: inspirationTypes[0]?.id ?? item.typeId }; updateDraft({ ...draft, items: [created, ...draft.items] }); setSelectedId(created.id); setCreateOpen(false); setMobilePane("detail"); }} />}
      {adoptionOpen && selected && <AdoptionDialog inspiration={selected} narrative={narrative} profile={profile} onClose={() => setAdoptionOpen(false)} onConfirm={(adoption) => { updateDraft({ ...draft, adoptions: [...draft.adoptions, adoption] }); setAdoptionOpen(false); }} />}
    </div>
  );
}
