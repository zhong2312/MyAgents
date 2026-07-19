import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDot,
  FileText,
  GitBranch,
  GitMerge,
  ListTree,
  Loader2,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import MarkdownVisualEditor from "./MarkdownVisualEditor";
import NarrativeSelect from "./NarrativeSelect";
import { auditNarrativeStudio } from "./narrativeStudioAudit";
import {
  resolveCreativeProfile,
  type ChapterPlan,
  type CreativeProfile,
  type CreativeDefinitionScope,
  type InspirationLibrary,
  type NarrativeArc,
  type NarrativeDesign,
  type NarrativeExpectation,
  type NarrativeNode,
  type NarrativeObjectKind,
  type NarrativePlanStatus,
  type NarrativeRelation,
  type NarrativeChecklistItem,
  type ResolvedCreativeDefinition,
  type NarrativeStructure,
  type NarrativeThread,
} from "./narrativeStudioSchema";
import type { LoadedNovelChapter } from "./repository";

export type NarrativeView =
  | "threads"
  | "arcs"
  | "chapters"
  | "expectations"
  | "validation"
  | "outline";

export interface NarrativeFocus {
  readonly kind: NarrativeObjectKind;
  readonly id: string;
}

interface NarrativeDesignWorkbenchProps {
  readonly narrative: NarrativeDesign;
  readonly narrativeContent: string;
  readonly inspirations: InspirationLibrary;
  readonly profile: CreativeProfile;
  readonly chapters: readonly LoadedNovelChapter[];
  readonly outlineContent: string;
  readonly isSaving: boolean;
  readonly focus: NarrativeFocus | null;
  readonly onFocusConsumed: () => void;
  readonly onSaveNarrative: (value: NarrativeDesign) => Promise<void>;
  readonly onSaveOutline: (
    value: string,
    expectedContent: string,
  ) => Promise<void>;
  readonly onOpenInspiration: (id: string) => void;
}

type NarrativeObject =
  | NarrativeStructure
  | NarrativeThread
  | NarrativeArc
  | NarrativeNode
  | NarrativeExpectation
  | ChapterPlan;

const VIEW_ITEMS: readonly { readonly id: NarrativeView; readonly label: string }[] = [
  { id: "threads", label: "线路" },
  { id: "arcs", label: "故事弧" },
  { id: "chapters", label: "章节计划" },
  { id: "expectations", label: "期待追踪" },
  { id: "validation", label: "验收" },
  { id: "outline", label: "自由大纲" },
];

const STATUS_OPTIONS: readonly { readonly value: NarrativePlanStatus; readonly label: string }[] = [
  { value: "planned", label: "计划中" },
  { value: "active", label: "进行中" },
  { value: "complete", label: "已完成" },
  { value: "paused", label: "已暂停" },
  { value: "abandoned", label: "已放弃" },
];

const OBJECT_LABELS: Readonly<Record<NarrativeObjectKind, string>> = {
  structure: "结构单元",
  thread: "叙事线路",
  arc: "故事弧",
  node: "叙事节点",
  expectation: "期待",
  "chapter-plan": "章节计划",
};

const THREAD_COLORS = ["#c26d3a", "#2e6f5e", "#4a7ab5", "#9a641e", "#a24f4f", "#7864a6"] as const;

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createDefaultObject(
  kind: NarrativeObjectKind,
  name: string,
  narrative: NarrativeDesign,
  chapters: readonly LoadedNovelChapter[],
  parentStructureId: string | null,
): NarrativeObject {
  const title = name.trim() || `新${OBJECT_LABELS[kind]}`;
  if (kind === "structure") {
    return {
      id: createId("structure"),
      parentId: parentStructureId ?? "structure-root",
      typeId: "core.structure",
      title,
      summary: "",
      order: narrative.structures.length,
      status: "planned",
      acceptanceCriteria: [],
    };
  }
  if (kind === "thread") {
    return {
      id: createId("thread"),
      typeId: "core.thread",
      title,
      summary: "",
      color: THREAD_COLORS[narrative.threads.length % THREAD_COLORS.length],
      order: narrative.threads.length,
      status: "planned",
      checklist: [],
    };
  }
  if (kind === "arc") {
    return {
      id: createId("arc"),
      title,
      summary: "",
      status: "planned",
      threadIds: [],
      characterIds: [],
      stages: ["起点", "发展", "转变", "终点"].map((label, index) => ({
        id: createId("arc-stage"),
        label,
        state: "",
        structureId: parentStructureId,
        chapterId: "",
        order: index,
      })),
      checklist: [],
    };
  }
  if (kind === "node") {
    return {
      id: createId("node"),
      typeId: "core.node",
      title,
      summary: "",
      status: "planned",
      structureId: parentStructureId,
      chapterId: "",
      sequence: narrative.nodes.length,
      threadIds: narrative.threads[0] ? [narrative.threads[0].id] : [],
      arcIds: [],
      emotionTarget: "",
      resultDimension: "",
      commercialBeat: "",
      situation: { condition: "", action: "", cost: "", result: "" },
      checklist: [],
    };
  }
  if (kind === "expectation") {
    return {
      id: createId("expectation"),
      typeId: "core.expectation",
      title,
      summary: "",
      status: "open",
      threadIds: narrative.threads[0] ? [narrative.threads[0].id] : [],
      milestones: [
        {
          id: createId("milestone"),
          kind: "establish",
          chapterId: "",
          label: "建立期待",
          ownership: "planned",
          order: 0,
        },
      ],
      checklist: [],
    };
  }
  const unusedChapter = chapters.find(
    (chapter) =>
      !narrative.chapterPlans.some((plan) => plan.chapterId === chapter.id),
  );
  const chapterNumber =
    unusedChapter?.number ??
    Math.max(0, ...narrative.chapterPlans.map((plan) => plan.chapterNumber)) + 1;
  return {
    id: createId("chapter-plan"),
    chapterId: unusedChapter?.id ?? "",
    chapterNumber,
    title: unusedChapter?.title || title,
    status: "planned",
    objective: "",
    summary: "",
    beats: [],
    threadIds: [],
    arcIds: [],
    expectationIds: [],
    deliveryValues: {},
    checklist: [],
  };
}

function appendObject(
  narrative: NarrativeDesign,
  kind: NarrativeObjectKind,
  value: NarrativeObject,
): NarrativeDesign {
  switch (kind) {
    case "structure":
      return { ...narrative, structures: [...narrative.structures, value as NarrativeStructure] };
    case "thread":
      return { ...narrative, threads: [...narrative.threads, value as NarrativeThread] };
    case "arc":
      return { ...narrative, arcs: [...narrative.arcs, value as NarrativeArc] };
    case "node":
      return { ...narrative, nodes: [...narrative.nodes, value as NarrativeNode] };
    case "expectation":
      return { ...narrative, expectations: [...narrative.expectations, value as NarrativeExpectation] };
    case "chapter-plan":
      return { ...narrative, chapterPlans: [...narrative.chapterPlans, value as ChapterPlan] };
  }
}

function replaceObject(
  narrative: NarrativeDesign,
  kind: NarrativeObjectKind,
  value: NarrativeObject,
): NarrativeDesign {
  switch (kind) {
    case "structure":
      return { ...narrative, structures: narrative.structures.map((item) => item.id === value.id ? value as NarrativeStructure : item) };
    case "thread":
      return { ...narrative, threads: narrative.threads.map((item) => item.id === value.id ? value as NarrativeThread : item) };
    case "arc":
      return { ...narrative, arcs: narrative.arcs.map((item) => item.id === value.id ? value as NarrativeArc : item) };
    case "node":
      return { ...narrative, nodes: narrative.nodes.map((item) => item.id === value.id ? value as NarrativeNode : item) };
    case "expectation":
      return { ...narrative, expectations: narrative.expectations.map((item) => item.id === value.id ? value as NarrativeExpectation : item) };
    case "chapter-plan":
      return { ...narrative, chapterPlans: narrative.chapterPlans.map((item) => item.id === value.id ? value as ChapterPlan : item) };
  }
}

function removeObject(
  narrative: NarrativeDesign,
  selection: NarrativeFocus,
): NarrativeDesign {
  const { kind, id } = selection;
  const withoutRelations = narrative.relations.filter(
    (relation) =>
      !(relation.fromKind === kind && relation.fromId === id) &&
      !(relation.toKind === kind && relation.toId === id),
  );
  if (kind === "structure") {
    return {
      ...narrative,
      structures: narrative.structures.filter((item) => item.id !== id).map((item) => item.parentId === id ? { ...item, parentId: "structure-root" } : item),
      nodes: narrative.nodes.map((item) => item.structureId === id ? { ...item, structureId: null } : item),
      arcs: narrative.arcs.map((arc) => ({ ...arc, stages: arc.stages.map((stage) => stage.structureId === id ? { ...stage, structureId: null } : stage) })),
      relations: withoutRelations,
    };
  }
  if (kind === "thread") {
    return {
      ...narrative,
      threads: narrative.threads.filter((item) => item.id !== id),
      arcs: narrative.arcs.map((item) => ({ ...item, threadIds: item.threadIds.filter((value) => value !== id) })),
      nodes: narrative.nodes.map((item) => ({ ...item, threadIds: item.threadIds.filter((value) => value !== id) })),
      expectations: narrative.expectations.map((item) => ({ ...item, threadIds: item.threadIds.filter((value) => value !== id) })),
      chapterPlans: narrative.chapterPlans.map((item) => ({ ...item, threadIds: item.threadIds.filter((value) => value !== id) })),
      relations: withoutRelations,
    };
  }
  if (kind === "arc") {
    return {
      ...narrative,
      arcs: narrative.arcs.filter((item) => item.id !== id),
      nodes: narrative.nodes.map((item) => ({ ...item, arcIds: item.arcIds.filter((value) => value !== id) })),
      chapterPlans: narrative.chapterPlans.map((item) => ({ ...item, arcIds: item.arcIds.filter((value) => value !== id) })),
      relations: withoutRelations,
    };
  }
  if (kind === "node") {
    return { ...narrative, nodes: narrative.nodes.filter((item) => item.id !== id), relations: withoutRelations };
  }
  if (kind === "expectation") {
    return {
      ...narrative,
      expectations: narrative.expectations.filter((item) => item.id !== id),
      chapterPlans: narrative.chapterPlans.map((item) => ({ ...item, expectationIds: item.expectationIds.filter((value) => value !== id) })),
      relations: withoutRelations,
    };
  }
  return {
    ...narrative,
    chapterPlans: narrative.chapterPlans.filter((item) => item.id !== id),
    relations: withoutRelations,
  };
}

function getObject(
  narrative: NarrativeDesign,
  selection: NarrativeFocus,
): NarrativeObject | undefined {
  switch (selection.kind) {
    case "structure":
      return narrative.structures.find((item) => item.id === selection.id);
    case "thread":
      return narrative.threads.find((item) => item.id === selection.id);
    case "arc":
      return narrative.arcs.find((item) => item.id === selection.id);
    case "node":
      return narrative.nodes.find((item) => item.id === selection.id);
    case "expectation":
      return narrative.expectations.find((item) => item.id === selection.id);
    case "chapter-plan":
      return narrative.chapterPlans.find((item) => item.id === selection.id);
  }
}

function getObjectTitle(
  narrative: NarrativeDesign,
  kind: NarrativeObjectKind,
  id: string,
): string {
  return getObject(narrative, { kind, id })?.title ?? id;
}

function structureRows(
  structures: readonly NarrativeStructure[],
  parentId: string | null,
  collapsedIds: ReadonlySet<string>,
  depth = 0,
): readonly { readonly item: NarrativeStructure; readonly depth: number }[] {
  return structures
    .filter((item) => item.parentId === parentId)
    .sort((left, right) => left.order - right.order)
    .flatMap((item) => [
      { item, depth },
      ...(collapsedIds.has(item.id)
        ? []
        : structureRows(structures, item.id, collapsedIds, depth + 1)),
    ]);
}

function structureDescendantIds(
  structures: readonly NarrativeStructure[],
  structureId: string,
): ReadonlySet<string> {
  const descendants = new Set<string>();
  const pending = [structureId];

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId) continue;
    structures.forEach((structure) => {
      if (
        structure.parentId !== currentId ||
        structure.id === structureId ||
        descendants.has(structure.id)
      ) {
        return;
      }
      descendants.add(structure.id);
      pending.push(structure.id);
    });
  }

  return descendants;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="ns-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function CreativeFieldEditor({
  field,
  value,
  onChange,
}: {
  readonly field: ResolvedCreativeDefinition;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const label = `${field.name}${field.required ? " · 必填" : ""}`;
  if (field.valueType === "boolean") {
    return (
      <div className="ns-field">
        <span>{label}</span>
        <label className="ns-check-row flex items-center gap-2">
          <input
            type="checkbox"
            checked={value === "true"}
            onChange={(event) => onChange(event.target.checked ? "true" : "false")}
          />
          <span>{value === "true" ? "是" : "否"}</span>
        </label>
      </div>
    );
  }
  if (field.valueType === "single-select") {
    const hasStaleValue = Boolean(value) && !field.options.includes(value);
    return (
      <Field label={label}>
        <NarrativeSelect
          className="ns-select"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">未选择</option>
          {hasStaleValue && <option value={value}>{value} · 已移除选项</option>}
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NarrativeSelect>
      </Field>
    );
  }
  if (field.valueType === "multi-select") {
    const selected = new Set(
      value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    );
    const options = [
      ...field.options,
      ...[...selected].filter((option) => !field.options.includes(option)),
    ];
    return (
      <div className="ns-field">
        <span>{label}</span>
        <div className="ns-check-list">
          {options.length === 0 && (
            <span className="ns-pane-meta">该字段尚未配置选项</span>
          )}
          {options.map((option) => (
            <label className="ns-check-row flex items-center gap-2" key={option}>
              <input
                type="checkbox"
                checked={selected.has(option)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(option);
                  else next.delete(option);
                  onChange([...next].join("\n"));
                }}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (field.valueType === "text" || field.valueType === "number") {
    return (
      <Field label={label}>
        <input
          className="ns-input"
          type={field.valueType === "number" ? "number" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  }
  return (
    <Field label={label}>
      <textarea
        className="ns-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function ObjectTypeField({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly ResolvedCreativeDefinition[];
  readonly onChange: (value: string) => void;
}) {
  const hasStaleValue = !options.some((option) => option.id === value);
  return (
    <Field label={label}>
      <NarrativeSelect
        className="ns-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {hasStaleValue && <option value={value}>保留类型</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name} · {option.layerName}
          </option>
        ))}
      </NarrativeSelect>
    </Field>
  );
}

function IdChecklist({
  title,
  options,
  values,
  onChange,
}: {
  readonly title: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
}) {
  return (
    <section className="ns-section">
      <div className="ns-section-header">{title}</div>
      <div className="ns-check-list">
        {options.length === 0 && <span className="ns-pane-meta">暂无可关联对象</span>}
        {options.map((option) => (
          <div className="ns-check-row" key={option.id}>
            <label>
              <input
                type="checkbox"
                checked={values.includes(option.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...values, option.id]
                      : values.filter((id) => id !== option.id),
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

function NarrativeChecklistEditor({
  title,
  items,
  definitions,
  onChange,
}: {
  readonly title: string;
  readonly items: readonly NarrativeChecklistItem[];
  readonly definitions: readonly ResolvedCreativeDefinition[];
  readonly onChange: (items: NarrativeChecklistItem[]) => void;
}) {
  const attachedDefinitionIds = new Set(
    items.flatMap((item) =>
      item.sourceDefinitionId ? [item.sourceDefinitionId] : [],
    ),
  );
  const missingDefinitions = definitions.filter(
    (definition) => !attachedDefinitionIds.has(definition.id),
  );
  const updateItem = (
    id: string,
    patch: Partial<NarrativeChecklistItem>,
  ) =>
    onChange(
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );

  return (
    <section className="ns-section">
      <div className="ns-section-header">{title}</div>
      <div className="ns-check-list">
        {items.length === 0 && missingDefinitions.length === 0 && (
          <span className="ns-pane-meta">暂无检查项</span>
        )}
        {items.map((item) => {
          const source = definitions.find(
            (definition) => definition.id === item.sourceDefinitionId,
          );
          return (
            <div className="ns-check-row" key={item.id}>
              <div className="ns-field-grid">
                <input
                  className="ns-input"
                  aria-label="检查项名称"
                  value={item.label}
                  disabled={Boolean(source)}
                  onChange={(event) =>
                    updateItem(item.id, { label: event.target.value })
                  }
                />
                <NarrativeSelect
                  className="ns-select"
                  aria-label="检查状态"
                  value={item.status}
                  onChange={(event) =>
                    updateItem(item.id, {
                      status: event.target.value as NarrativeChecklistItem["status"],
                    })
                  }
                >
                  <option value="pending">待检查</option>
                  <option value="passed">已通过</option>
                  <option value="waived">手工豁免</option>
                </NarrativeSelect>
              </div>
              {source && (
                <div className="mt-1 text-[var(--ink-muted)]">
                  来源：{source.layerName} · {source.id}
                </div>
              )}
              {item.status === "waived" && (
                <textarea
                  className="ns-textarea mt-2"
                  value={item.waiverReason}
                  placeholder="填写豁免原因"
                  onChange={(event) =>
                    updateItem(item.id, { waiverReason: event.target.value })
                  }
                />
              )}
              <div className="ns-row-actions is-end">
                <button
                  className="ns-icon-button"
                  type="button"
                  title="删除检查项"
                  onClick={() =>
                    onChange(items.filter((candidate) => candidate.id !== item.id))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {missingDefinitions.length > 0 && (
        <div className="ns-row-actions">
          {missingDefinitions.map((definition) => (
            <button
              className="ns-button"
              type="button"
              key={definition.id}
              onClick={() =>
                onChange([
                  ...items,
                  {
                    id: createId("check"),
                    label: definition.name,
                    sourceDefinitionId: definition.id,
                    status: "pending",
                    waiverReason: "",
                  },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" />
              接入 {definition.name}
            </button>
          ))}
        </div>
      )}
      <button
        className="ns-button mt-2"
        type="button"
        onClick={() =>
          onChange([
            ...items,
            {
              id: createId("check"),
              label: "新检查项",
              sourceDefinitionId: null,
              status: "pending",
              waiverReason: "",
            },
          ])
        }
      >
        <Plus className="h-3.5 w-3.5" />添加自定义检查
      </button>
    </section>
  );
}

function Inspector({
  narrative,
  selection,
  inspirations,
  profile,
  chapters,
  onChange,
  onAddRelation,
  onRemoveRelation,
  onRemove,
  onOpenInspiration,
}: {
  readonly narrative: NarrativeDesign;
  readonly selection: NarrativeFocus;
  readonly inspirations: InspirationLibrary;
  readonly profile: CreativeProfile;
  readonly chapters: readonly LoadedNovelChapter[];
  readonly onChange: (value: NarrativeObject) => void;
  readonly onAddRelation: (relation: NarrativeRelation) => void;
  readonly onRemoveRelation: (relationId: string) => void;
  readonly onRemove: () => void;
  readonly onOpenInspiration: (id: string) => void;
}) {
  const value = getObject(narrative, selection);
  const [relationTarget, setRelationTarget] = useState("");
  if (!value) return <div className="ns-empty">对象已不存在</div>;
  const allObjects = [
    ...narrative.structures.map((item) => ({ kind: "structure" as const, id: item.id, label: item.title })),
    ...narrative.threads.map((item) => ({ kind: "thread" as const, id: item.id, label: item.title })),
    ...narrative.arcs.map((item) => ({ kind: "arc" as const, id: item.id, label: item.title })),
    ...narrative.nodes.map((item) => ({ kind: "node" as const, id: item.id, label: item.title })),
    ...narrative.expectations.map((item) => ({ kind: "expectation" as const, id: item.id, label: item.title })),
    ...narrative.chapterPlans.map((item) => ({ kind: "chapter-plan" as const, id: item.id, label: item.title })),
  ].filter((item) => !(item.kind === selection.kind && item.id === selection.id));
  const connectedRelations = narrative.relations.filter(
    (relation) =>
      (relation.fromKind === selection.kind && relation.fromId === selection.id) ||
      (relation.toKind === selection.kind && relation.toId === selection.id),
  );
  const adoptedInspirations = inspirations.adoptions
    .filter(
      (adoption) =>
        adoption.targetKind === selection.kind && adoption.targetId === selection.id,
    )
    .map((adoption) => ({
      adoption,
      inspiration: inspirations.items.find((item) => item.id === adoption.inspirationId),
    }));
  const resolved = resolveCreativeProfile(profile);
  const chapterFields = resolved.definitions.filter(
    (item) => item.category === "field" && item.scope === "chapter",
  );
  const checksForScope = (
    scope: CreativeDefinitionScope,
  ): readonly ResolvedCreativeDefinition[] =>
    resolved.definitions.filter(
      (item) => item.category === "check" && item.scope === scope,
    );
  const objectTypesForScope = (
    scope: CreativeDefinitionScope,
  ): readonly ResolvedCreativeDefinition[] =>
    resolved.definitions.filter(
      (item) => item.category === "object-type" && item.scope === scope,
    );
  const update = (patch: Partial<NarrativeObject>) => onChange({ ...value, ...patch } as NarrativeObject);
  const statusField = "status" in value && selection.kind !== "expectation" ? (
    <Field label="状态">
      <NarrativeSelect
        className="ns-select"
        value={value.status}
        onChange={(event) => update({ status: event.target.value as NarrativePlanStatus })}
      >
        {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </NarrativeSelect>
    </Field>
  ) : null;

  let fields: ReactNode;
  if (selection.kind === "structure") {
    const item = value as NarrativeStructure;
    const descendantIds = structureDescendantIds(
      narrative.structures,
      item.id,
    );
    fields = (
      <>
        <Field label="名称"><input className="ns-input" value={item.title} onChange={(event) => update({ title: event.target.value })} /></Field>
        <div className="ns-field-grid">
          <ObjectTypeField label="结构类型" value={item.typeId} options={objectTypesForScope("structure")} onChange={(typeId) => update({ typeId })} />
          {statusField}
        </div>
        <Field label="上级结构">
          <NarrativeSelect className="ns-select" value={item.parentId ?? ""} disabled={item.id === "structure-root"} onChange={(event) => update({ parentId: event.target.value || null })}>
            <option value="">根结构</option>
            {narrative.structures
              .filter(
                (candidate) =>
                  candidate.id !== item.id && !descendantIds.has(candidate.id),
              )
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
          </NarrativeSelect>
        </Field>
        <Field label="摘要"><textarea className="ns-textarea" value={item.summary} onChange={(event) => update({ summary: event.target.value })} /></Field>
        <NarrativeChecklistEditor title="验收条件" items={item.acceptanceCriteria} definitions={checksForScope("structure")} onChange={(acceptanceCriteria) => update({ acceptanceCriteria })} />
      </>
    );
  } else if (selection.kind === "thread") {
    const item = value as NarrativeThread;
    fields = (
      <>
        <Field label="线路名称"><input className="ns-input" value={item.title} onChange={(event) => update({ title: event.target.value })} /></Field>
        <div className="ns-field-grid">
          <ObjectTypeField label="线路类型" value={item.typeId} options={objectTypesForScope("thread")} onChange={(typeId) => update({ typeId })} />
          {statusField}
        </div>
        <Field label="线路颜色"><input className="ns-input" type="color" value={item.color} onChange={(event) => update({ color: event.target.value })} /></Field>
        <Field label="推进说明"><textarea className="ns-textarea" value={item.summary} onChange={(event) => update({ summary: event.target.value })} /></Field>
        <NarrativeChecklistEditor title="线路验收" items={item.checklist} definitions={checksForScope("thread")} onChange={(checklist) => update({ checklist })} />
      </>
    );
  } else if (selection.kind === "arc") {
    const item = value as NarrativeArc;
    fields = (
      <>
        <Field label="故事弧名称"><input className="ns-input" value={item.title} onChange={(event) => update({ title: event.target.value })} /></Field>
        {statusField}
        <Field label="变化摘要"><textarea className="ns-textarea" value={item.summary} onChange={(event) => update({ summary: event.target.value })} /></Field>
        <section className="ns-section">
          <div className="ns-section-header">状态阶段</div>
          <div className="ns-milestone-list">
            {[...item.stages].sort((left, right) => left.order - right.order).map((stage) => (
              <div className="ns-milestone-row" key={stage.id}>
                <input className="ns-input" value={stage.label} onChange={(event) => update({ stages: item.stages.map((candidate) => candidate.id === stage.id ? { ...candidate, label: event.target.value } : candidate) })} />
                <textarea className="ns-textarea" value={stage.state} placeholder="该阶段的状态" onChange={(event) => update({ stages: item.stages.map((candidate) => candidate.id === stage.id ? { ...candidate, state: event.target.value } : candidate) })} />
                <div className="ns-field-grid">
                  <NarrativeSelect className="ns-select" aria-label="阶段所在结构" value={stage.structureId ?? ""} onChange={(event) => update({ stages: item.stages.map((candidate) => candidate.id === stage.id ? { ...candidate, structureId: event.target.value || null } : candidate) })}>
                    <option value="">未定位结构</option>
                    {narrative.structures.map((structure) => <option key={structure.id} value={structure.id}>{structure.title}</option>)}
                  </NarrativeSelect>
                  <NarrativeSelect className="ns-select" aria-label="阶段章节锚点" value={stage.chapterId} onChange={(event) => update({ stages: item.stages.map((candidate) => candidate.id === stage.id ? { ...candidate, chapterId: event.target.value } : candidate) })}>
                    <option value="">未关联章节</option>
                    {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.number} 章 · {chapter.title}</option>)}
                  </NarrativeSelect>
                </div>
                <div className="ns-row-actions is-end"><button className="ns-icon-button" type="button" title="删除阶段" disabled={item.stages.length <= 2} onClick={() => update({ stages: item.stages.filter((candidate) => candidate.id !== stage.id) })}><Trash2 className="h-3.5 w-3.5" /></button></div>
              </div>
            ))}
          </div>
          <button className="ns-button" type="button" onClick={() => update({ stages: [...item.stages, { id: createId("arc-stage"), label: `阶段 ${item.stages.length + 1}`, state: "", structureId: null, chapterId: "", order: Math.max(-1, ...item.stages.map((stage) => stage.order)) + 1 }] })}><Plus className="h-3.5 w-3.5" />添加阶段</button>
        </section>
        <IdChecklist title="关联线路" options={narrative.threads.map((thread) => ({ id: thread.id, label: thread.title }))} values={item.threadIds} onChange={(threadIds) => update({ threadIds })} />
        <NarrativeChecklistEditor title="故事弧验收" items={item.checklist} definitions={checksForScope("arc")} onChange={(checklist) => update({ checklist })} />
      </>
    );
  } else if (selection.kind === "node") {
    const item = value as NarrativeNode;
    fields = (
      <>
        <Field label="节点名称"><input className="ns-input" value={item.title} onChange={(event) => update({ title: event.target.value })} /></Field>
        <div className="ns-field-grid">
          <ObjectTypeField label="节点类型" value={item.typeId} options={objectTypesForScope("node")} onChange={(typeId) => update({ typeId })} />
          {statusField}
        </div>
        <div className="ns-field-grid">
          <Field label="结构位置"><NarrativeSelect className="ns-select" value={item.structureId ?? ""} onChange={(event) => update({ structureId: event.target.value || null })}><option value="">未定位</option>{narrative.structures.map((structure) => <option key={structure.id} value={structure.id}>{structure.title}</option>)}</NarrativeSelect></Field>
          <Field label="章节锚点"><NarrativeSelect className="ns-select" value={item.chapterId} onChange={(event) => update({ chapterId: event.target.value })}><option value="">未锚定</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.number} 章 · {chapter.title}</option>)}</NarrativeSelect></Field>
        </div>
        <Field label="摘要"><textarea className="ns-textarea" value={item.summary} onChange={(event) => update({ summary: event.target.value })} /></Field>
        <div className="ns-field-grid">
          <Field label="情绪目标"><input className="ns-input" value={item.emotionTarget} onChange={(event) => update({ emotionTarget: event.target.value })} /></Field>
          <Field label="连载节点"><input className="ns-input" value={item.commercialBeat} onChange={(event) => update({ commercialBeat: event.target.value })} /></Field>
        </div>
        <Field label="结果维度"><textarea className="ns-textarea" value={item.resultDimension} onChange={(event) => update({ resultDimension: event.target.value })} /></Field>
        <section className="ns-section">
          <div className="ns-section-header">情境 · 条件 / 行动 / 代价 / 结果</div>
          {(["condition", "action", "cost", "result"] as const).map((key) => (
            <Field key={key} label={{ condition: "条件", action: "行动", cost: "代价", result: "结果" }[key]}><input className="ns-input" value={item.situation[key]} onChange={(event) => update({ situation: { ...item.situation, [key]: event.target.value } })} /></Field>
          ))}
        </section>
        <IdChecklist title="关联线路" options={narrative.threads.map((thread) => ({ id: thread.id, label: thread.title }))} values={item.threadIds} onChange={(threadIds) => update({ threadIds })} />
        <IdChecklist title="关联故事弧" options={narrative.arcs.map((arc) => ({ id: arc.id, label: arc.title }))} values={item.arcIds} onChange={(arcIds) => update({ arcIds })} />
        <NarrativeChecklistEditor title="节点验收" items={item.checklist} definitions={checksForScope("node")} onChange={(checklist) => update({ checklist })} />
      </>
    );
  } else if (selection.kind === "expectation") {
    const item = value as NarrativeExpectation;
    fields = (
      <>
        <Field label="期待名称"><input className="ns-input" value={item.title} onChange={(event) => update({ title: event.target.value })} /></Field>
        <div className="ns-field-grid">
          <ObjectTypeField label="期待类型" value={item.typeId} options={objectTypesForScope("expectation")} onChange={(typeId) => update({ typeId })} />
          <Field label="状态"><NarrativeSelect className="ns-select" value={item.status} onChange={(event) => update({ status: event.target.value as NarrativeExpectation["status"] })}><option value="open">待兑现</option><option value="fulfilled">已兑现</option><option value="abandoned">已失效</option></NarrativeSelect></Field>
        </div>
        <Field label="摘要"><textarea className="ns-textarea" value={item.summary} onChange={(event) => update({ summary: event.target.value })} /></Field>
        <section className="ns-section">
          <div className="ns-section-header">建立、强化与兑现</div>
          <div className="ns-milestone-list">
            {[...item.milestones].sort((left, right) => left.order - right.order).map((milestone) => (
              <div className="ns-milestone-row" key={milestone.id}>
                <div className="ns-field-grid">
                  <NarrativeSelect className="ns-select" value={milestone.kind} onChange={(event) => update({ milestones: item.milestones.map((candidate) => candidate.id === milestone.id ? { ...candidate, kind: event.target.value as typeof milestone.kind } : candidate) })}><option value="establish">建立</option><option value="reinforce">强化</option><option value="fulfill">兑现</option><option value="invalidate">失效</option></NarrativeSelect>
                  <NarrativeSelect className="ns-select" value={milestone.ownership} onChange={(event) => update({ milestones: item.milestones.map((candidate) => candidate.id === milestone.id ? { ...candidate, ownership: event.target.value as typeof milestone.ownership } : candidate) })}><option value="planned">计划</option><option value="actual">已发生事实</option></NarrativeSelect>
                </div>
                <input className="ns-input" value={milestone.label} onChange={(event) => update({ milestones: item.milestones.map((candidate) => candidate.id === milestone.id ? { ...candidate, label: event.target.value } : candidate) })} />
                <NarrativeSelect className="ns-select" value={milestone.chapterId} onChange={(event) => update({ milestones: item.milestones.map((candidate) => candidate.id === milestone.id ? { ...candidate, chapterId: event.target.value } : candidate) })}><option value="">未关联章节</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.number} 章 · {chapter.title}</option>)}</NarrativeSelect>
                <div className="ns-row-actions is-end"><button className="ns-icon-button" type="button" title="删除阶段" onClick={() => update({ milestones: item.milestones.filter((candidate) => candidate.id !== milestone.id) })}><Trash2 className="h-3.5 w-3.5" /></button></div>
              </div>
            ))}
          </div>
          <button className="ns-button" type="button" onClick={() => update({ milestones: [...item.milestones, { id: createId("milestone"), kind: "reinforce", chapterId: "", label: "新的期待动作", ownership: "planned", order: item.milestones.length }] })}><Plus className="h-3.5 w-3.5" />添加阶段</button>
        </section>
        <IdChecklist title="关联线路" options={narrative.threads.map((thread) => ({ id: thread.id, label: thread.title }))} values={item.threadIds} onChange={(threadIds) => update({ threadIds })} />
        <NarrativeChecklistEditor title="期待验收" items={item.checklist} definitions={checksForScope("expectation")} onChange={(checklist) => update({ checklist })} />
      </>
    );
  } else {
    const item = value as ChapterPlan;
    fields = (
      <>
        <Field label="章节标题"><input className="ns-input" value={item.title} onChange={(event) => update({ title: event.target.value })} /></Field>
        <div className="ns-field-grid">
          <Field label="正文章节"><NarrativeSelect className="ns-select" value={item.chapterId} onChange={(event) => { const chapter = chapters.find((candidate) => candidate.id === event.target.value); update({ chapterId: event.target.value, ...(chapter ? { chapterNumber: chapter.number, title: chapter.title } : {}) }); }}><option value="">仅计划，尚无正文</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.number} 章 · {chapter.title}</option>)}</NarrativeSelect></Field>
          {statusField}
        </div>
        <Field label="章节目标"><textarea className="ns-textarea" value={item.objective} onChange={(event) => update({ objective: event.target.value })} /></Field>
        <Field label="章节摘要"><textarea className="ns-textarea" value={item.summary} onChange={(event) => update({ summary: event.target.value })} /></Field>
        <Field label="关键节拍（每行一项）"><textarea className="ns-textarea" value={item.beats.join("\n")} onChange={(event) => update({ beats: event.target.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) })} /></Field>
        {chapterFields.length > 0 && (
          <section className="ns-section">
            <div className="ns-section-header">方案交付字段</div>
            {chapterFields.map((field) => (
              <CreativeFieldEditor
                key={field.id}
                field={field}
                value={item.deliveryValues[field.id] ?? ""}
                onChange={(fieldValue) =>
                  update({
                    deliveryValues: {
                      ...item.deliveryValues,
                      [field.id]: fieldValue,
                    },
                  })
                }
              />
            ))}
          </section>
        )}
        <IdChecklist title="来源线路" options={narrative.threads.map((thread) => ({ id: thread.id, label: thread.title }))} values={item.threadIds} onChange={(threadIds) => update({ threadIds })} />
        <IdChecklist title="涉及故事弧" options={narrative.arcs.map((arc) => ({ id: arc.id, label: arc.title }))} values={item.arcIds} onChange={(arcIds) => update({ arcIds })} />
        <IdChecklist title="期待动作" options={narrative.expectations.map((expectation) => ({ id: expectation.id, label: expectation.title }))} values={item.expectationIds} onChange={(expectationIds) => update({ expectationIds })} />
        <NarrativeChecklistEditor title="章节验收" items={item.checklist} definitions={checksForScope("chapter")} onChange={(checklist) => update({ checklist })} />
      </>
    );
  }

  const addRelation = (ownership: "planned" | "actual") => {
    const target = allObjects.find((item) => `${item.kind}:${item.id}` === relationTarget);
    if (!target) return;
    const next = {
      id: createId("narrative-relation"),
      typeId: ownership === "planned" ? "core.planned-anchor" : "core.actual-event",
      fromKind: selection.kind,
      fromId: selection.id,
      toKind: target.kind,
      toId: target.id,
      ownership,
      note: "",
    } as const;
    onAddRelation(next);
    setRelationTarget("");
  };

  return (
    <div className="ns-inspector-body">
      <div className="ns-kicker">{OBJECT_LABELS[selection.kind]}</div>
      <h2 className="ns-object-title">{value.title}</h2>
      {"summary" in value && value.summary && <p className="ns-object-summary">{value.summary}</p>}
      <section className="ns-section">{fields}</section>
      <section className="ns-section">
        <div className="ns-section-header">关系 · 区分计划与事实</div>
        <div className="ns-relation-list">
          {connectedRelations.length === 0 && <span className="ns-pane-meta">尚未建立对象关系</span>}
          {connectedRelations.map((relation) => {
            const outgoing = relation.fromKind === selection.kind && relation.fromId === selection.id;
            const otherKind = outgoing ? relation.toKind : relation.fromKind;
            const otherId = outgoing ? relation.toId : relation.fromId;
            return (
              <div className={`ns-relation-row ${relation.ownership === "actual" ? "is-actual" : ""}`} key={relation.id}>
                <strong>{relation.ownership === "actual" ? "已发生事实" : "计划锚点"}</strong>
                <div>{outgoing ? "指向" : "来自"} {OBJECT_LABELS[otherKind]} · {getObjectTitle(narrative, otherKind, otherId)}</div>
                <div className="ns-row-actions is-end"><button className="ns-icon-button" type="button" title="删除关系" onClick={() => onRemoveRelation(relation.id)}><Trash2 className="h-3.5 w-3.5" /></button></div>
              </div>
            );
          })}
        </div>
        <div className="ns-field">
          <NarrativeSelect className="ns-select" aria-label="关系目标" value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)}>
            <option value="">选择关系目标</option>
            {allObjects.map((item) => <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>{OBJECT_LABELS[item.kind]} · {item.label}</option>)}
          </NarrativeSelect>
        </div>
        <div className="ns-row-actions">
          <button className="ns-button" type="button" disabled={!relationTarget} onClick={() => addRelation("planned")}>添加计划关系</button>
          <button className="ns-button" type="button" disabled={!relationTarget} onClick={() => addRelation("actual")}>添加事实关系</button>
        </div>
      </section>
      <section className="ns-section">
        <div className="ns-section-header">来源灵感</div>
        <div className="ns-relation-list">
          {adoptedInspirations.length === 0 && <span className="ns-pane-meta">尚未关联项目灵感</span>}
          {adoptedInspirations.map(({ adoption, inspiration }) => (
            <button className="ns-relation-row" type="button" key={adoption.id} onClick={() => onOpenInspiration(adoption.inspirationId)}>
              <strong>{inspiration?.title ?? adoption.inspirationId}</strong>
              <div>采用为 {adoption.adoptedTypeLabel}</div>
            </button>
          ))}
        </div>
      </section>
      {!(selection.kind === "structure" && selection.id === "structure-root") && (
        <section className="ns-section">
          <button className="ns-button is-danger" type="button" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" />删除{OBJECT_LABELS[selection.kind]}</button>
        </section>
      )}
    </div>
  );
}

function CreateObjectDialog({
  onClose,
  onCreate,
}: {
  readonly onClose: () => void;
  readonly onCreate: (kind: NarrativeObjectKind, name: string) => void;
}) {
  const [kind, setKind] = useState<NarrativeObjectKind>("node");
  const [name, setName] = useState("");
  return (
    <div className="ns-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="ns-dialog" onSubmit={(event) => { event.preventDefault(); onCreate(kind, name); }}>
        <header className="ns-dialog-header">
          <Plus className="h-4 w-4 text-[var(--accent-warm)]" />
          <h2>新建叙事对象</h2>
          <button className="ns-icon-button ml-auto" type="button" title="关闭" aria-label="关闭" onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        <div className="ns-dialog-body">
          <Field label="对象类型"><NarrativeSelect className="ns-select" value={kind} onChange={(event) => setKind(event.target.value as NarrativeObjectKind)}>{Object.entries(OBJECT_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</NarrativeSelect></Field>
          <Field label="名称"><input autoFocus className="ns-input" value={name} placeholder={`输入${OBJECT_LABELS[kind]}名称`} onChange={(event) => setName(event.target.value)} /></Field>
        </div>
        <footer className="ns-dialog-footer">
          <button className="ns-button" type="button" onClick={onClose}>取消</button>
          <button className="ns-button is-primary" type="submit" disabled={!name.trim()}>创建</button>
        </footer>
      </form>
    </div>
  );
}

export default function NarrativeDesignWorkbench({
  narrative,
  narrativeContent,
  inspirations,
  profile,
  chapters,
  outlineContent,
  isSaving,
  focus,
  onFocusConsumed,
  onSaveNarrative,
  onSaveOutline,
  onOpenInspiration,
}: NarrativeDesignWorkbenchProps) {
  const [draft, setDraft] = useState(narrative);
  const [baselineContent, setBaselineContent] = useState(narrativeContent);
  const [dirty, setDirty] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const [view, setView] = useState<NarrativeView>("threads");
  const [selection, setSelection] = useState<NarrativeFocus>({ kind: "structure", id: "structure-root" });
  const [mobilePane, setMobilePane] = useState<"structure" | "content" | "detail">("content");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [collapsedStructureIds, setCollapsedStructureIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [outlineDraft, setOutlineDraft] = useState(outlineContent);
  const [outlineBaseline, setOutlineBaseline] = useState(outlineContent);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [outlineSaving, setOutlineSaving] = useState(false);

  useEffect(() => {
    if (narrativeContent === baselineContent) return;
    const timer = window.setTimeout(() => {
      setBaselineContent(narrativeContent);
      if (dirty) setExternalChanged(true);
      else setDraft(narrative);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [baselineContent, dirty, narrative, narrativeContent]);

  useEffect(() => {
    if (outlineContent === outlineBaseline) return;
    const timer = window.setTimeout(() => {
      if (outlineDraft === outlineBaseline) {
        setOutlineDraft(outlineContent);
        setOutlineBaseline(outlineContent);
        setOutlineError(null);
      } else {
        setOutlineError("自由大纲已在外部修改，本地草稿未被覆盖");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [outlineBaseline, outlineContent, outlineDraft]);

  useEffect(() => {
    if (!focus) return;
    const timer = window.setTimeout(() => {
      setSelection(focus);
      setMobilePane("detail");
      onFocusConsumed();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focus, onFocusConsumed]);

  const updateDraft = (next: NarrativeDesign) => {
    setDraft(next);
    setDirty(true);
    setSaveError(null);
  };
  const selectObject = (next: NarrativeFocus) => {
    setSelection(next);
    if (window.matchMedia("(max-width: 720px)").matches) setMobilePane("detail");
  };
  const selectedStructureId = selection.kind === "structure" ? selection.id : draft.nodes.find((item) => item.id === selection.id)?.structureId ?? null;
  const structureTree = structureRows(
    draft.structures,
    null,
    collapsedStructureIds,
  );
  const chapterIds = useMemo(() => new Set(chapters.map((chapter) => chapter.id)), [chapters]);
  const audit = useMemo(() => auditNarrativeStudio(draft, inspirations, profile, chapterIds), [chapterIds, draft, inspirations, profile]);
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const matches = (value: string) => !normalizedSearch || value.toLocaleLowerCase("zh-CN").includes(normalizedSearch);

  const save = async () => {
    if (!dirty || isSaving) return;
    setSaveError(null);
    try {
      await onSaveNarrative(draft);
      setDirty(false);
      setExternalChanged(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveOutline = async () => {
    if (outlineDraft === outlineBaseline || outlineSaving) return;
    setOutlineSaving(true);
    setOutlineError(null);
    try {
      await onSaveOutline(outlineDraft, outlineBaseline);
      setOutlineBaseline(outlineDraft);
    } catch (error) {
      setOutlineError(error instanceof Error ? error.message : String(error));
    } finally {
      setOutlineSaving(false);
    }
  };

  const createObject = (kind: NarrativeObjectKind, name: string) => {
    const created = createDefaultObject(kind, name, draft, chapters, selectedStructureId);
    updateDraft(appendObject(draft, kind, created));
    setSelection({ kind, id: created.id });
    setCreateOpen(false);
    setMobilePane("detail");
    setView(kind === "thread" || kind === "node" ? "threads" : kind === "arc" ? "arcs" : kind === "expectation" ? "expectations" : kind === "chapter-plan" ? "chapters" : view);
  };

  const removeSelected = () => {
    const selected = getObject(draft, selection);
    if (!selected || !window.confirm(`确认删除“${selected.title}”？关联引用会被安全解除。`)) return;
    updateDraft(removeObject(draft, selection));
    setSelection({ kind: "structure", id: "structure-root" });
  };

  const renderContent = () => {
    if (view === "outline") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="ns-content-toolbar">
            <FileText className="h-4 w-4 text-[var(--accent-warm)]" />
            <strong className="text-sm">outline/outline.md</strong>
            <span className="ns-header-spacer" />
            <button className="ns-button" type="button" disabled={outlineDraft === outlineBaseline || outlineSaving} onClick={() => void saveOutline()}>{outlineSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存大纲</button>
          </div>
          {outlineError && <div className="ns-warning-banner"><AlertTriangle className="h-4 w-4" />{outlineError}<button className="ns-button ml-auto" type="button" onClick={() => { setOutlineDraft(outlineContent); setOutlineBaseline(outlineContent); setOutlineError(null); }}>载入磁盘版本</button></div>}
          <MarkdownVisualEditor pageId="outline/outline.md" label="自由大纲" value={outlineDraft} onChange={setOutlineDraft} onSave={() => void saveOutline()} fullWidth placeholder="从故事核心、冲突、人物欲望或任意片段开始……" />
        </div>
      );
    }
    if (view === "threads") {
      const columns = chapters.length ? chapters.slice(0, 12).map((chapter) => ({ id: chapter.id, label: String(chapter.number) })) : Array.from({ length: 8 }, (_, index) => ({ id: `sequence-${index}`, label: `阶段 ${index + 1}` }));
      const visibleThreads = draft.threads.filter((thread) => matches(`${thread.title} ${thread.summary}`)).sort((left, right) => left.order - right.order);
      if (!visibleThreads.length) return <div className="ns-empty"><div><GitBranch className="mx-auto h-5 w-5" /><strong className="mt-3">尚未建立叙事线路</strong><p>先新建主线、人物线、关系线、调查线或任何项目自定义线路。</p></div></div>;
      return (
        <div className="ns-lane-scroll">
          <div className="ns-lane-board" style={{ "--ns-columns": columns.length } as React.CSSProperties}>
            <div className="ns-lane-axis"><div className="ns-axis-cell">线路 / 章节</div>{columns.map((column) => <div className="ns-axis-cell" key={column.id}>{column.label}</div>)}</div>
            {visibleThreads.map((thread) => (
              <div className="ns-lane-row" key={thread.id}>
                <button className="ns-lane-label" type="button" onClick={() => selectObject({ kind: "thread", id: thread.id })}>{thread.title}</button>
                {columns.map((column, columnIndex) => {
                  const nodes = draft.nodes.filter((node) => node.threadIds.includes(thread.id) && (chapters.length ? node.chapterId === column.id : Math.min(node.sequence, columns.length - 1) === columnIndex));
                  return <div className="ns-lane-cell" key={column.id}>{nodes.map((node) => <button key={node.id} type="button" className={`ns-lane-node ${selection.kind === "node" && selection.id === node.id ? "is-active" : ""}`} style={{ "--ns-thread-color": thread.color } as React.CSSProperties} onClick={() => selectObject({ kind: "node", id: node.id })}><strong>{node.title}</strong><span>{node.emotionTarget || node.situation.cost || "叙事节点"}</span></button>)}</div>;
                })}
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (view === "arcs") {
      const arcs = draft.arcs.filter((arc) => matches(`${arc.title} ${arc.summary}`));
      if (!arcs.length) return <div className="ns-empty"><div><GitMerge className="mx-auto h-5 w-5" /><strong className="mt-3">尚未建立故事弧</strong><p>故事弧记录角色、关系、主题或局势从起点到终点的状态变化。</p></div></div>;
      const stageColumnCount = Math.max(2, ...arcs.map((arc) => arc.stages.length));
      const stageHeaders = Array.from({ length: stageColumnCount }, (_, index) => index === 0 ? "起点" : index === stageColumnCount - 1 ? "终点" : `阶段 ${index + 1}`);
      return <div className="ns-content-scroll"><div className="ns-arc-grid" style={{ gridTemplateColumns: `10rem repeat(${stageColumnCount}, minmax(9rem, 1fr))`, minWidth: `${10 + stageColumnCount * 9}rem` }}><div className="ns-arc-cell is-heading">故事弧</div>{stageHeaders.map((label, index) => <div className="ns-arc-cell is-heading" key={`${index}:${label}`}>{label}</div>)}{arcs.flatMap((arc) => [<button className="ns-arc-cell is-label" type="button" key={`${arc.id}:label`} onClick={() => selectObject({ kind: "arc", id: arc.id })}>{arc.title}</button>, ...Array.from({ length: stageColumnCount }, (_, index) => { const stage = [...arc.stages].sort((left, right) => left.order - right.order)[index]; return <button className="ns-arc-cell" type="button" key={`${arc.id}:${index}`} onClick={() => selectObject({ kind: "arc", id: arc.id })}><strong>{stage?.label ?? "未设置"}</strong><span className="ns-cell-subtitle">{stage?.state || "等待填写状态"}</span></button>; })])}</div></div>;
    }
    if (view === "chapters") {
      const plans = draft.chapterPlans.filter((plan) => matches(`${plan.title} ${plan.objective} ${plan.summary}`)).sort((left, right) => left.chapterNumber - right.chapterNumber);
      if (!plans.length) return <div className="ns-empty"><div><FileText className="mx-auto h-5 w-5" /><strong className="mt-3">尚未建立章节计划</strong><p>章节计划把线路、故事弧、期待和当前创作方案声明的交付字段汇总到一处。</p></div></div>;
      return <div className="ns-table-wrap"><table className="ns-table"><thead><tr><th>章节</th><th>章节目标</th><th>关键节拍</th><th>来源线路</th><th>期待</th><th>结果维度</th><th>状态</th></tr></thead><tbody>{plans.map((plan) => { const resultDimensions = draft.nodes.filter((node) => Boolean(plan.chapterId) && node.chapterId === plan.chapterId && node.resultDimension.trim()).map((node) => node.resultDimension.trim()); return <tr className={selection.kind === "chapter-plan" && selection.id === plan.id ? "is-active" : ""} key={plan.id} onClick={() => selectObject({ kind: "chapter-plan", id: plan.id })}><td>CH.{String(plan.chapterNumber).padStart(3, "0")}</td><td><span className="ns-cell-title">{plan.title}</span><span className="ns-cell-subtitle">{plan.objective || "尚未填写章节目标"}</span></td><td>{plan.beats.slice(0, 2).join(" / ") || "—"}</td><td><div className="ns-tags">{plan.threadIds.map((id) => <span className="ns-tag" key={id}>{getObjectTitle(draft, "thread", id)}</span>)}</div></td><td>{plan.expectationIds.length}</td><td>{resultDimensions.join(" / ") || "—"}</td><td><span className="ns-badge">{STATUS_OPTIONS.find((option) => option.value === plan.status)?.label}</span></td></tr>; })}</tbody></table></div>;
    }
    if (view === "expectations") {
      const expectations = draft.expectations.filter((item) => matches(`${item.title} ${item.summary}`));
      if (!expectations.length) return <div className="ns-empty"><div><CircleDot className="mx-auto h-5 w-5" /><strong className="mt-3">尚未建立期待</strong><p>承诺、悬念、谜团、伏笔和预言都使用同一套建立、强化、兑现与失效追踪。</p></div></div>;
      return <div className="ns-list">{expectations.map((item) => { const done = item.milestones.filter((milestone) => milestone.ownership === "actual").length; return <button className={`ns-list-row ${selection.kind === "expectation" && selection.id === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => selectObject({ kind: "expectation", id: item.id })}><span className="ns-list-title">{item.title}</span><span className={`ns-badge ${item.status === "fulfilled" ? "is-success" : item.status === "abandoned" ? "is-error" : "is-warning"}`}>{item.status === "fulfilled" ? "已兑现" : item.status === "abandoned" ? "已失效" : "待兑现"}</span><span className="ns-list-summary">{item.milestones.length} 个追踪阶段 · {done} 个已发生事实 · {item.summary || "暂无摘要"}</span></button>; })}</div>;
    }
    const errors = audit.filter((issue) => issue.severity === "error").length;
    const warnings = audit.filter((issue) => issue.severity === "warning").length;
    const suggestions = audit.filter((issue) => issue.severity === "suggestion").length;
    const auditGroups = [...audit.reduce((groups, issue) => { const current = groups.get(issue.source) ?? []; groups.set(issue.source, [...current, issue]); return groups; }, new Map<string, typeof audit>())];
    return <div><div className="ns-validation-summary"><span className="ns-badge is-error">{errors} 错误</span><span className="ns-badge is-warning">{warnings} 警告</span><span className="ns-badge">{suggestions} 建议</span></div>{audit.length === 0 ? <div className="ns-empty"><div><Check className="mx-auto h-5 w-5 text-[var(--success)]" /><strong className="mt-3">当前检查全部通过</strong><p>引用完整，开放期待已有兑现计划，必填交付字段也已填写。</p></div></div> : <div>{auditGroups.map(([source, issues]) => <section className="ns-validation-group" key={source}><div className="ns-section-header">{source} · {issues.length}</div><div className="ns-list">{issues.map((issue) => <button className="ns-list-row" type="button" key={issue.id} onClick={() => { if (issue.targetKind && issue.targetId) selectObject({ kind: issue.targetKind, id: issue.targetId }); }}><span className="ns-list-title">{issue.title}</span><span className={`ns-badge ${issue.severity === "error" ? "is-error" : issue.severity === "warning" ? "is-warning" : ""}`}>{issue.severity === "error" ? "错误" : issue.severity === "warning" ? "警告" : "建议"}</span><span className="ns-list-summary">{issue.detail}</span></button>)}</div></section>)}</div>}</div>;
  };

  const selected = getObject(draft, selection);
  const projectRuleName =
    profile.layers.find((layer) => layer.kind === "project")?.name ??
    "项目规则";
  return (
    <div className="narrative-studio" data-mobile-pane={mobilePane}>
      <header className="ns-header">
        <h1 className="ns-title">叙事设计</h1>
        <span className="ns-subtitle">{projectRuleName}</span>
        <nav className="ns-tabs" aria-label="叙事设计视图">{VIEW_ITEMS.map((item) => <button className={`ns-tab ${view === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => { setView(item.id); setMobilePane("content"); }}>{item.label}</button>)}</nav>
        <span className="ns-header-spacer" />
        <label className="ns-search"><Search className="h-3.5 w-3.5" /><input value={search} placeholder="搜索对象" onChange={(event) => setSearch(event.target.value)} /></label>
        {view !== "outline" && <button className="ns-button" type="button" disabled={!dirty || isSaving} onClick={() => void save()}>{isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : dirty ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5 text-[var(--success)]" />}{isSaving ? "保存中" : dirty ? "保存" : "已保存"}</button>}
        <button className="ns-button is-primary" type="button" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建</button>
      </header>
      {(saveError || externalChanged) && <div className="ns-warning-banner"><AlertTriangle className="h-4 w-4" /><span>{saveError ?? "叙事文件已在外部修改，本地草稿未被覆盖"}</span>{externalChanged && <button className="ns-button ml-auto" type="button" onClick={() => { setDraft(narrative); setDirty(false); setExternalChanged(false); setSaveError(null); }}>载入磁盘版本</button>}</div>}
      <div className="ns-mobile-tabs"><button className={`ns-segment-button ${mobilePane === "structure" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("structure")}>结构</button><button className={`ns-segment-button ${mobilePane === "content" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("content")}>内容</button><button className={`ns-segment-button ${mobilePane === "detail" ? "is-active" : ""}`} type="button" onClick={() => setMobilePane("detail")}>详情</button></div>
      <div className="ns-workspace">
        <aside className="ns-pane ns-tree-pane">
          <div className="ns-pane-header"><ListTree className="h-4 w-4 text-[var(--accent-warm)]" /><strong>故事结构</strong><span className="ns-header-spacer" /><span className="ns-count">{draft.structures.length}</span></div>
          <div className="ns-tree-list">{structureTree.map(({ item, depth }) => { const hasChildren = draft.structures.some((candidate) => candidate.parentId === item.id); const collapsed = collapsedStructureIds.has(item.id); return <button className={`ns-tree-row ${selection.kind === "structure" && selection.id === item.id ? "is-active" : ""}`} type="button" key={item.id} style={{ paddingLeft: `${0.5 + depth * 1.05}rem` }} onClick={(event) => { if ((event.target as HTMLElement).closest("[data-tree-toggle]")) { setCollapsedStructureIds((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; }); return; } selectObject({ kind: "structure", id: item.id }); }}><span className="ns-tree-toggle" data-tree-toggle={hasChildren ? "true" : undefined}>{hasChildren && <ChevronRight className={`h-3.5 w-3.5 transition-transform ${collapsed ? "" : "rotate-90"}`} />}</span><span className="ns-tree-label">{item.title}</span><span className="ns-count">{draft.nodes.filter((node) => node.structureId === item.id).length}</span></button>; })}</div>
          <div className="ns-tree-note">结构名称来自配置包；它可以显示为卷、幕、案件、人生阶段或作者自定义术语。</div>
        </aside>
        <main className="ns-pane ns-content-pane">{renderContent()}</main>
        <aside className="ns-pane ns-inspector-pane"><div className="ns-pane-header"><Sparkles className="h-4 w-4 text-[var(--accent-warm)]" /><strong>对象详情</strong><span className="ns-header-spacer" />{selected && <span className="ns-pane-meta">{OBJECT_LABELS[selection.kind]}</span>}</div>{selected ? <Inspector narrative={draft} selection={selection} inspirations={inspirations} profile={profile} chapters={chapters} onChange={(value) => updateDraft(replaceObject(draft, selection.kind, value))} onAddRelation={(relation) => updateDraft({ ...draft, relations: [...draft.relations, relation] })} onRemoveRelation={(relationId) => updateDraft({ ...draft, relations: draft.relations.filter((relation) => relation.id !== relationId) })} onRemove={removeSelected} onOpenInspiration={onOpenInspiration} /> : <div className="ns-empty">请选择一个对象</div>}</aside>
      </div>
      {createOpen && <CreateObjectDialog onClose={() => setCreateOpen(false)} onCreate={createObject} />}
    </div>
  );
}
