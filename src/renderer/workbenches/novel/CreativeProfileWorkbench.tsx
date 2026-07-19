import {
  AlertTriangle,
  Check,
  ChevronRight,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  createMysteryPreviewProfile,
  resolveCreativeProfile,
  type CreativeDefinition,
  type CreativeDefinitionCategory,
  type CreativeDefinitionScope,
  type CreativeProfile,
  type CreativeProfileLayer,
  type ResolvedCreativeDefinition,
} from "./narrativeStudioSchema";
import NarrativeSelect from "./NarrativeSelect";

interface CreativeProfileWorkbenchProps {
  readonly profile: CreativeProfile;
  readonly content: string;
  readonly isSaving: boolean;
  readonly onSave: (value: CreativeProfile) => Promise<void>;
}

const CATEGORY_ITEMS: readonly { readonly id: CreativeDefinitionCategory; readonly label: string }[] = [
  { id: "term", label: "术语" },
  { id: "object-type", label: "对象类型" },
  { id: "field", label: "字段" },
  { id: "relation", label: "关系" },
  { id: "check", label: "检查项" },
  { id: "view", label: "视图" },
];

const SCOPE_LABELS: Readonly<Record<CreativeDefinitionScope, string>> = {
  global: "全局",
  structure: "结构单元",
  thread: "叙事线路",
  arc: "故事弧",
  node: "叙事节点",
  expectation: "期待",
  chapter: "章节",
  inspiration: "灵感",
};

const LAYER_KIND_LABELS: Readonly<Record<CreativeProfileLayer["kind"], string>> = {
  core: "通用内核",
  length: "篇幅",
  publication: "发布方式",
  genre: "题材",
  method: "创作方法",
  project: "项目规则",
  author: "作者调整",
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

function DefinitionDialog({
  layer,
  profile,
  onClose,
  onCreate,
}: {
  readonly layer: CreativeProfileLayer;
  readonly profile: CreativeProfile;
  readonly onClose: () => void;
  readonly onCreate: (definition: CreativeDefinition) => void;
}) {
  const availableTargets = resolveCreativeProfile(profile).definitions;
  const [category, setCategory] = useState<CreativeDefinitionCategory>("field");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [operation, setOperation] = useState<CreativeDefinition["operation"]>("define");
  const [targetId, setTargetId] = useState("");
  const [scope, setScope] = useState<CreativeDefinitionScope>("chapter");
  const [valueType, setValueType] = useState<NonNullable<CreativeDefinition["valueType"]>>("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const normalizedId = id
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const applyOverrideTarget = (nextTargetId: string) => {
    setTargetId(nextTargetId);
    if (operation !== "override") return;
    const target = availableTargets.find((item) => item.id === nextTargetId);
    setId(nextTargetId);
    if (!target) return;
    setCategory(target.category);
    setScope(target.scope);
    if (target.valueType) setValueType(target.valueType);
    setRequired(target.required);
    setOptions(target.options.join("，"));
  };
  return (
    <div className="ns-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="ns-dialog" onSubmit={(event) => { event.preventDefault(); onCreate({ id: normalizedId || createId("definition"), category, name: name.trim(), description, operation, targetId: operation === "define" ? null : targetId || null, scope, valueType: category === "field" ? valueType : null, required: category === "field" ? required : false, options: category === "field" && (valueType === "single-select" || valueType === "multi-select") ? options.split(/[，,\n]/u).map((item) => item.trim()).filter(Boolean) : [] }); }}>
        <header className="ns-dialog-header"><Plus className="h-4 w-4 text-[var(--accent-warm)]" /><h2>向“{layer.name}”添加定义</h2><button className="ns-icon-button ml-auto" type="button" title="关闭" aria-label="关闭" onClick={onClose}><X className="h-4 w-4" /></button></header>
        <div className="ns-dialog-body">
          <div className="ns-field-grid"><Field label="定义类别"><NarrativeSelect className="ns-select" value={category} disabled={operation === "override"} onChange={(event) => setCategory(event.target.value as CreativeDefinitionCategory)}>{CATEGORY_ITEMS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</NarrativeSelect></Field><Field label="作用对象"><NarrativeSelect className="ns-select" value={scope} disabled={operation === "override"} onChange={(event) => setScope(event.target.value as CreativeDefinitionScope)}>{Object.entries(SCOPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NarrativeSelect></Field></div>
          <Field label="显示名称"><input autoFocus className="ns-input" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="稳定定义 ID"><input className="ns-input font-mono" value={id} disabled={operation === "override"} placeholder="例如 project.chapter.emotion-payoff" onChange={(event) => setId(event.target.value)} /></Field>
          <Field label="解析方式"><NarrativeSelect className="ns-select" value={operation} onChange={(event) => { const nextOperation = event.target.value as CreativeDefinition["operation"]; setOperation(nextOperation); if (nextOperation === "override" && targetId) { const target = availableTargets.find((item) => item.id === targetId); setId(targetId); if (target) { setCategory(target.category); setScope(target.scope); if (target.valueType) setValueType(target.valueType); setRequired(target.required); setOptions(target.options.join("，")); } } }}><option value="define">新增稳定定义</option><option value="extend">扩展已有定义</option><option value="override">显式覆盖已有定义</option></NarrativeSelect></Field>
          {operation !== "define" && <Field label={operation === "override" ? "被覆盖定义" : "被扩展定义"}><NarrativeSelect className="ns-select" value={targetId} onChange={(event) => applyOverrideTarget(event.target.value)}><option value="">请选择目标</option>{availableTargets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</NarrativeSelect></Field>}
          {category === "field" && <><div className="ns-field-grid"><Field label="字段类型"><NarrativeSelect className="ns-select" value={valueType} disabled={operation === "override"} onChange={(event) => setValueType(event.target.value as typeof valueType)}><option value="text">单行文本</option><option value="long-text">多行文本</option><option value="number">数字</option><option value="boolean">开关</option><option value="single-select">单选</option><option value="multi-select">多选</option></NarrativeSelect></Field><Field label="必填"><NarrativeSelect className="ns-select" value={required ? "yes" : "no"} onChange={(event) => setRequired(event.target.value === "yes")}><option value="no">可选</option><option value="yes">必填并参与验收</option></NarrativeSelect></Field></div>{(valueType === "single-select" || valueType === "multi-select") && <Field label="选项（逗号或换行分隔）"><textarea className="ns-textarea" value={options} onChange={(event) => setOptions(event.target.value)} /></Field>}</>}
          <Field label="定义说明"><textarea className="ns-textarea" value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        </div>
        <footer className="ns-dialog-footer"><button className="ns-button" type="button" onClick={onClose}>取消</button><button className="ns-button is-primary" type="submit" disabled={!name.trim() || !normalizedId || (operation !== "define" && !targetId)}>添加定义</button></footer>
      </form>
    </div>
  );
}

export default function CreativeProfileWorkbench({
  profile,
  content,
  isSaving,
  onSave,
}: CreativeProfileWorkbenchProps) {
  const [draft, setDraft] = useState(profile);
  const [baselineContent, setBaselineContent] = useState(content);
  const [dirty, setDirty] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [category, setCategory] = useState<CreativeDefinitionCategory>("term");
  const [selectedLayerId, setSelectedLayerId] = useState(profile.layers.find((layer) => layer.kind === "project")?.id ?? profile.layers[0]?.id ?? "");
  const [selectedDefinitionId, setSelectedDefinitionId] = useState("");
  const [search, setSearch] = useState("");
  const [mobilePane, setMobilePane] = useState<"structure" | "content" | "detail">("content");
  const [definitionDialogOpen, setDefinitionDialogOpen] = useState(false);

  useEffect(() => {
    if (content === baselineContent) return;
    const timer = window.setTimeout(() => {
      setBaselineContent(content);
      if (dirty) setExternalChanged(true);
      else setDraft(profile);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [baselineContent, content, dirty, profile]);

  const effectiveProfile = useMemo(() => preview ? createMysteryPreviewProfile(draft) : draft, [draft, preview]);
  const resolved = useMemo(() => resolveCreativeProfile(effectiveProfile), [effectiveProfile]);
  const selectedLayer = effectiveProfile.layers.find((layer) => layer.id === selectedLayerId) ?? effectiveProfile.layers[0];
  const selectedDefinition = resolved.definitions.find((item) => item.id === selectedDefinitionId);
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const definitions = resolved.definitions.filter((item) => item.category === category && (!normalizedSearch || `${item.name} ${item.description} ${item.id}`.toLocaleLowerCase("zh-CN").includes(normalizedSearch)));
  const blockingConflicts = resolved.conflicts.filter((item) => item.severity === "error");

  const updateDraft = (next: CreativeProfile) => {
    setDraft(next);
    setDirty(true);
    setSaveError(null);
  };

  const updateLayer = (layerId: string, patch: Partial<CreativeProfileLayer>) => {
    updateDraft({ ...draft, layers: draft.layers.map((layer) => layer.id === layerId ? { ...layer, ...patch } : layer) });
  };

  const updateDefinition = (definition: ResolvedCreativeDefinition, patch: Partial<CreativeDefinition>) => {
    const layer = draft.layers.find((candidate) => candidate.id === definition.layerId);
    if (!layer || layer.locked) return;
    updateLayer(layer.id, { definitions: layer.definitions.map((item) => item.id === definition.id ? { ...item, ...patch } : item) });
  };

  const save = async () => {
    if (!dirty || isSaving || preview || blockingConflicts.length > 0) return;
    setSaveError(null);
    try {
      await onSave(draft);
      setDirty(false);
      setExternalChanged(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="narrative-studio" data-mobile-pane={mobilePane}>
      <header className="ns-header">
        <h1 className="ns-title">创作方案</h1>
        <span className="ns-subtitle">声明定义与视图，不执行项目代码</span>
        <span className="ns-header-spacer" />
        <label className="ns-search"><Search className="h-3.5 w-3.5" /><input value={search} placeholder="搜索定义" onChange={(event) => setSearch(event.target.value)} /></label>
        <button className="ns-button" type="button" onClick={() => { setPreview((current) => !current); setSelectedDefinitionId(""); }}>{preview ? "退出悬疑预览" : "悬疑长篇预览"}</button>
        <button className="ns-button is-primary" type="button" disabled={!dirty || isSaving || preview || blockingConflicts.length > 0} title={blockingConflicts.length ? "存在阻断冲突，不能应用方案" : "保存并应用当前方案"} onClick={() => void save()}>{isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : dirty ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}{isSaving ? "应用中" : dirty ? "应用方案" : "已应用"}</button>
      </header>
      {preview && <div className="ns-preview-banner"><Layers3 className="h-4 w-4" /><strong>悬疑长篇临时预览</strong><span>只替换题材与项目规则定义，不写入正式配置。</span></div>}
      {(saveError || externalChanged) && <div className="ns-warning-banner"><RefreshCw className="h-4 w-4" /><span>{saveError ?? "创作方案已在外部修改，本地草稿未被覆盖"}</span>{externalChanged && <button className="ns-button ml-auto" type="button" onClick={() => { setDraft(profile); setDirty(false); setExternalChanged(false); setSaveError(null); setPreview(false); }}>载入磁盘版本</button>}</div>}
      {blockingConflicts.length > 0 && <div className="ns-error-banner"><ShieldAlert className="h-4 w-4" /><strong>{blockingConflicts.length} 个阻断冲突</strong><span>{blockingConflicts[0]?.message}</span></div>}
      <div className="ns-mobile-tabs"><button className={`ns-segment-button ${mobilePane === "structure" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("structure")}>层级</button><button className={`ns-segment-button ${mobilePane === "content" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("content")}>定义</button><button className={`ns-segment-button ${mobilePane === "detail" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("detail")}>影响</button></div>
      <div className="ns-workspace">
        <aside className="ns-pane ns-tree-pane">
          <div className="ns-pane-header"><Layers3 className="h-4 w-4 text-[var(--accent-warm)]" /><strong>方案层级</strong><span className="ns-header-spacer" /><span className="ns-count">{effectiveProfile.layers.filter((layer) => layer.enabled).length}</span></div>
          <div className="ns-layer-list">{[...effectiveProfile.layers].sort((left, right) => left.order - right.order).map((layer, index) => <button className={`ns-layer-row ${selectedLayer?.id === layer.id ? "is-active" : ""}`} type="button" key={layer.id} onClick={() => { setSelectedLayerId(layer.id); setSelectedDefinitionId(""); if (window.matchMedia("(max-width: 720px)").matches) setMobilePane("detail"); }}><span className="ns-layer-index">{index + 1}</span><span className="min-w-0"><span className="ns-layer-name">{layer.name}</span><span className="ns-layer-description">{LAYER_KIND_LABELS[layer.kind]} · {layer.source}</span></span><span className={`ns-switch ${layer.enabled ? "is-on" : ""}`} role="switch" aria-checked={layer.enabled} onClick={(event) => { event.stopPropagation(); if (!layer.locked && !preview) updateLayer(layer.id, { enabled: !layer.enabled }); }} /></button>)}</div>
          <div className="ns-tree-note">下层可以扩展或显式覆盖上层。直接重复稳定定义 ID 会阻断应用，但不会删除任何已有数据。</div>
        </aside>
        <main className="ns-pane ns-content-pane">
          <div className="ns-content-toolbar"><nav className="ns-tabs" aria-label="定义类别">{CATEGORY_ITEMS.map((item) => <button className={`ns-tab ${category === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}</nav><span className="ns-header-spacer" /><span className="ns-pane-meta">{definitions.length} 项解析定义</span>{selectedLayer && !selectedLayer.locked && !preview && <button className="ns-button" type="button" onClick={() => setDefinitionDialogOpen(true)}><Plus className="h-3.5 w-3.5" />添加定义</button>}</div>
          <div className="ns-table-wrap"><table className="ns-table"><thead><tr><th>显示名称</th><th>含义</th><th>来源</th><th>解析方式</th></tr></thead><tbody>{definitions.map((item) => <tr className={selectedDefinitionId === item.id ? "is-active" : ""} key={item.id} onClick={() => { setSelectedDefinitionId(item.id); setSelectedLayerId(item.layerId); if (window.matchMedia("(max-width: 720px)").matches) setMobilePane("detail"); }}><td><span className="ns-cell-title">{item.name}</span><span className="ns-cell-subtitle font-mono">{item.id}</span></td><td>{item.description || "—"}</td><td><span className="ns-badge">{item.layerName}</span></td><td>{item.operation === "define" ? "新增" : item.operation === "extend" ? `扩展 ${item.targetId}` : `覆盖 ${item.targetId}`}</td></tr>)}</tbody></table>{definitions.length === 0 && <div className="ns-empty"><div><Layers3 className="mx-auto h-5 w-5" /><strong className="mt-3">当前类别没有定义</strong><p>选择一个可编辑层并添加术语、字段、关系、检查项或视图。</p></div></div>}</div>
        </main>
        <aside className="ns-pane ns-inspector-pane">
          <div className="ns-pane-header"><ChevronRight className="h-4 w-4 text-[var(--accent-warm)]" /><strong>影响与来源</strong></div>
          {!selectedLayer ? <div className="ns-empty">请选择一个方案层</div> : <div className="ns-inspector-body">
            <div className="ns-kicker">{LAYER_KIND_LABELS[selectedLayer.kind]} · {selectedLayer.source}</div>
            <h2 className="ns-object-title">{selectedDefinition?.name ?? selectedLayer.name}</h2>
            <p className="ns-object-summary">{selectedDefinition?.description || selectedLayer.description}</p>
            {selectedDefinition ? <>
              <section className="ns-section"><div className="ns-section-header">稳定定义</div><Field label="显示名称"><input className="ns-input" value={selectedDefinition.name} disabled={selectedLayer.locked || preview} onChange={(event) => updateDefinition(selectedDefinition, { name: event.target.value })} /></Field><Field label="稳定 ID"><input className="ns-input font-mono" value={selectedDefinition.id} disabled /></Field><Field label="说明"><textarea className="ns-textarea" value={selectedDefinition.description} disabled={selectedLayer.locked || preview} onChange={(event) => updateDefinition(selectedDefinition, { description: event.target.value })} /></Field><div className="ns-field-grid"><Field label="作用对象"><NarrativeSelect className="ns-select" value={selectedDefinition.scope} disabled={selectedLayer.locked || preview} onChange={(event) => updateDefinition(selectedDefinition, { scope: event.target.value as CreativeDefinitionScope })}>{Object.entries(SCOPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NarrativeSelect></Field><Field label="解析方式"><input className="ns-input" value={selectedDefinition.operation === "define" ? "新增稳定定义" : selectedDefinition.operation === "extend" ? `扩展 ${selectedDefinition.targetId}` : `覆盖 ${selectedDefinition.targetId}`} disabled /></Field></div>{selectedDefinition.category === "field" && <Field label="参与验收"><NarrativeSelect className="ns-select" value={selectedDefinition.required ? "required" : "optional"} disabled={selectedLayer.locked || preview} onChange={(event) => updateDefinition(selectedDefinition, { required: event.target.value === "required" })}><option value="optional">可选字段</option><option value="required">必填并生成验收问题</option></NarrativeSelect></Field>}</section>
              <section className="ns-section"><div className="ns-section-header">工作面影响</div><div className="ns-relation-list"><div className="ns-relation-row"><strong>{SCOPE_LABELS[selectedDefinition.scope]}</strong><div>{selectedDefinition.category === "field" ? "出现在对象详情和对应计划表中" : selectedDefinition.category === "check" ? "出现在验收来源分组中" : selectedDefinition.category === "view" ? "声明可启用的项目视图" : "影响新建对象与作者术语"}</div></div>{selectedDefinition.overriddenDefinitionId && <div className="ns-relation-row is-actual"><strong>合法覆盖</strong><div>显式目标：{selectedDefinition.overriddenDefinitionId}</div></div>}</div></section>
              {!selectedLayer.locked && !preview && <section className="ns-section"><button className="ns-button is-danger" type="button" onClick={() => { updateLayer(selectedLayer.id, { definitions: selectedLayer.definitions.filter((item) => item.id !== selectedDefinition.id) }); setSelectedDefinitionId(""); }}><Trash2 className="h-3.5 w-3.5" />删除定义</button></section>}
            </> : <>
              <section className="ns-section"><div className="ns-section-header">层设置</div><Field label="层名称"><input className="ns-input" value={selectedLayer.name} disabled={selectedLayer.locked || preview} onChange={(event) => updateLayer(selectedLayer.id, { name: event.target.value })} /></Field><Field label="说明"><textarea className="ns-textarea" value={selectedLayer.description} disabled={selectedLayer.locked || preview} onChange={(event) => updateLayer(selectedLayer.id, { description: event.target.value })} /></Field><div className="ns-tags"><span className={`ns-badge ${selectedLayer.enabled ? "is-success" : ""}`}>{selectedLayer.enabled ? "已启用" : "已停用"}</span><span className="ns-badge">{selectedLayer.definitions.length} 项本层定义</span>{selectedLayer.locked && <span className="ns-badge">锁定内核</span>}</div></section>
              <section className="ns-section"><div className="ns-section-header">影响范围</div><div className="ns-relation-list">{CATEGORY_ITEMS.map((item) => { const count = selectedLayer.definitions.filter((definition) => definition.category === item.id).length; return count ? <div className="ns-relation-row" key={item.id}><strong>{item.label}</strong><div>{count} 项定义进入解析链</div></div> : null; })}</div></section>
              {selectedLayer.kind === "project" && <section className="ns-section"><div className="ns-relation-row"><strong>项目专属概念归属这里</strong><div>只属于当前作品的对象类型、字段、关系和验收规则应在项目规则中声明，不进入通用叙事内核。</div></div></section>}
            </>}
            {resolved.conflicts.length > 0 && <section className="ns-section"><div className="ns-section-header"><AlertTriangle className="h-3.5 w-3.5" />解析冲突</div><div className="ns-relation-list">{resolved.conflicts.filter((item) => item.layerId === selectedLayer.id).map((item) => <div className="ns-relation-row" key={item.id}><strong>{item.severity === "error" ? "阻断冲突" : "警告"}</strong><div>{item.message}</div></div>)}</div></section>}
          </div>}
        </aside>
      </div>
      {definitionDialogOpen && selectedLayer && <DefinitionDialog layer={selectedLayer} profile={draft} onClose={() => setDefinitionDialogOpen(false)} onCreate={(definition) => { updateLayer(selectedLayer.id, { definitions: [...selectedLayer.definitions, definition] }); setSelectedDefinitionId(definition.id); setCategory(definition.category); setDefinitionDialogOpen(false); setMobilePane("detail"); }} />}
    </div>
  );
}
