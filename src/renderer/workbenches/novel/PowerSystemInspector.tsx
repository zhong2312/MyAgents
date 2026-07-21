import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { CustomSelect } from "@/workbench-sdk";

import type {
  PowerCatalog,
  PowerCatalogEntity,
  PowerCapability,
  PowerConditionClause,
  PowerConditionGroup,
  PowerConnection,
  PowerConnections,
  PowerEntityReference,
  PowerFoundation,
  PowerMedium,
  PowerMethod,
  PowerMetricDimension,
  PowerMetricModifier,
  PowerMetricValue,
  PowerPrinciple,
  PowerProgressionState,
  PowerProgressionTrack,
  PowerProgressionTransition,
  PowerResource,
  PowerSystemIndex,
  PowerSystemMeta,
  PowerSystemRecord,
  PowerTheory,
  PowerTheoryOperation,
  PowerTruthMetadata,
} from "./powerSystemSchema";

export type PowerInspectorSelection =
  | { readonly kind: "system" }
  | { readonly kind: "catalog"; readonly id: string }
  | { readonly kind: "track"; readonly id: string }
  | { readonly kind: "state"; readonly trackId: string; readonly id: string }
  | {
      readonly kind: "transition";
      readonly trackId: string;
      readonly id: string;
    }
  | { readonly kind: "dimension"; readonly id: string }
  | { readonly kind: "connection"; readonly id: string };

interface ReferenceOption {
  readonly value: string;
  readonly label: string;
  readonly reference: PowerEntityReference;
}

interface PowerSystemInspectorProps {
  readonly selection: PowerInspectorSelection;
  readonly record: PowerSystemRecord;
  readonly catalog: PowerCatalog;
  readonly connections: PowerConnections;
  readonly meta: PowerSystemMeta;
  readonly index: PowerSystemIndex;
  readonly onRecordChange: (record: PowerSystemRecord) => void;
  readonly onCatalogChange: (catalog: PowerCatalog) => void;
  readonly onConnectionsChange: (connections: PowerConnections) => void;
  readonly onSelectionChange: (selection: PowerInspectorSelection) => void;
  readonly onDeleteSelection: () => void;
}

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]";
const textareaClass = `${inputClass} min-h-24 resize-y leading-5`;

const CATALOG_KIND_LABELS: Readonly<
  Record<PowerCatalogEntity["kind"], string>
> = {
  foundation: "力量本源",
  medium: "运行介质",
  principle: "底层法则",
  resource: "资源",
  theory: "理论模型",
  method: "发展方法",
  capability: "能力",
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function commaList(value: string): string[] {
  return value
    .split(/[，,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function InspectorHeader({
  eyebrow,
  title,
  onDelete,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly onDelete?: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between gap-3 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-4 py-2">
      <div className="min-w-0">
        <div className="text-xs font-medium text-[var(--accent-warm)]">
          {eyebrow}
        </div>
        <h2 className="truncate text-sm font-semibold text-[var(--ink)]">
          {title}
        </h2>
      </div>
      {onDelete && (
        <button
          type="button"
          title="删除"
          aria-label="删除当前对象"
          onClick={onDelete}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </header>
  );
}

function MetadataFields({
  value,
  onChange,
}: {
  readonly value: PowerTruthMetadata;
  readonly onChange: (value: PowerTruthMetadata) => void;
}) {
  return (
    <details className="border-t border-[var(--line-subtle)] pt-3">
      <summary className="cursor-pointer text-xs font-semibold text-[var(--ink-muted)]">
        设定治理与来源
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="设定层级">
            <input
              className={inputClass}
              value={value.settingLevel}
              onChange={(event) =>
                onChange({ ...value, settingLevel: event.target.value })
              }
            />
          </Field>
          <Field label="正文揭示阶段">
            <input
              className={inputClass}
              value={value.revealStage}
              onChange={(event) =>
                onChange({ ...value, revealStage: event.target.value })
              }
            />
          </Field>
        </div>
        <Field label="领域分类（逗号分隔）">
          <input
            className={inputClass}
            value={value.domainCategories.join("，")}
            onChange={(event) =>
              onChange({
                ...value,
                domainCategories: commaList(event.target.value),
              })
            }
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="权威级别">
            <CustomSelect
              value={value.authority}
              options={[
                { value: "hard", label: "硬规则" },
                { value: "default", label: "默认" },
                { value: "exception", label: "例外" },
                { value: "rumor", label: "传闻" },
              ]}
              onChange={(authority) =>
                onChange({
                  ...value,
                  authority: authority as PowerTruthMetadata["authority"],
                })
              }
              size="toolbar"
            />
          </Field>
          <Field label="Canon">
            <CustomSelect
              value={value.canon}
              options={[
                { value: "draft", label: "草案" },
                { value: "provisional", label: "暂定" },
                { value: "canon", label: "正史" },
                { value: "deprecated", label: "废弃" },
              ]}
              onChange={(canon) =>
                onChange({
                  ...value,
                  canon: canon as PowerTruthMetadata["canon"],
                })
              }
              size="toolbar"
            />
          </Field>
        </div>
        <Field label="空间节点 ID（逗号分隔）">
          <input
            className={inputClass}
            value={value.spatialScopeIds.join("，")}
            onChange={(event) =>
              onChange({
                ...value,
                spatialScopeIds: commaList(event.target.value),
              })
            }
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="有效时间起点">
            <input
              className={inputClass}
              value={value.timeScope.from}
              onChange={(event) =>
                onChange({
                  ...value,
                  timeScope: { ...value.timeScope, from: event.target.value },
                })
              }
            />
          </Field>
          <Field label="有效时间终点">
            <input
              className={inputClass}
              value={value.timeScope.to}
              onChange={(event) =>
                onChange({
                  ...value,
                  timeScope: { ...value.timeScope, to: event.target.value },
                })
              }
            />
          </Field>
        </div>
        <div className="border-t border-[var(--line-subtle)] pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--ink-muted)]">
              来源引用
            </span>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...value,
                  sourceRefs: [
                    ...value.sourceRefs,
                    {
                      id: createId("source"),
                      label: "新来源",
                      path: "",
                      anchor: "",
                      note: "",
                    },
                  ],
                })
              }
              className="text-xs font-medium text-[var(--accent-warm)]"
            >
              + 添加
            </button>
          </div>
          <div className="space-y-2">
            {value.sourceRefs.map((source) => (
              <div
                key={source.id}
                className="space-y-1.5 border-l-2 border-[var(--line-strong)] pl-2"
              >
                <div className="grid grid-cols-[1fr_2rem] gap-1.5">
                  <input
                    className={inputClass}
                    value={source.label}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        sourceRefs: value.sourceRefs.map((item) =>
                          item.id === source.id
                            ? { ...item, label: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    title="删除来源"
                    onClick={() =>
                      onChange({
                        ...value,
                        sourceRefs: value.sourceRefs.filter(
                          (item) => item.id !== source.id,
                        ),
                      })
                    }
                    className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  className={inputClass}
                  value={source.path}
                  placeholder="项目相对路径"
                  onChange={(event) =>
                    onChange({
                      ...value,
                      sourceRefs: value.sourceRefs.map((item) =>
                        item.id === source.id
                          ? { ...item, path: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
                <input
                  className={inputClass}
                  value={source.note}
                  placeholder="引用说明"
                  onChange={(event) =>
                    onChange({
                      ...value,
                      sourceRefs: value.sourceRefs.map((item) =>
                        item.id === source.id
                          ? { ...item, note: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

function referenceKey(reference: PowerEntityReference): string {
  return reference.namespace === "system"
    ? `system:${reference.systemId}:${reference.kind}:${reference.targetId}`
    : `${reference.namespace}:${reference.kind}:${reference.targetId}`;
}

function buildReferenceOptions(
  record: PowerSystemRecord,
  catalog: PowerCatalog,
  index: PowerSystemIndex,
): ReferenceOption[] {
  const catalogEntities: PowerCatalogEntity[] = [
    ...catalog.foundations,
    ...catalog.mediums,
    ...catalog.principles,
    ...catalog.resources,
    ...catalog.theories,
    ...catalog.methods,
    ...catalog.capabilities,
  ];
  const options: ReferenceOption[] = catalogEntities.map((entity) => {
    const reference = {
      namespace: "catalog" as const,
      kind: entity.kind,
      targetId: entity.id,
    };
    return {
      value: referenceKey(reference),
      label: `${entity.name} · ${CATALOG_KIND_LABELS[entity.kind]}`,
      reference,
    };
  });
  index.systems.forEach((system) => {
    const reference = {
      namespace: "system" as const,
      systemId: system.id,
      kind: "system" as const,
      targetId: system.id,
    };
    options.push({
      value: referenceKey(reference),
      label: `${system.name} · 力量体系`,
      reference,
    });
  });
  record.tracks.forEach((track) => {
    const trackRef = {
      namespace: "system" as const,
      systemId: record.id,
      kind: "track" as const,
      targetId: track.id,
    };
    options.push({
      value: referenceKey(trackRef),
      label: `${track.name} · 成长轨道`,
      reference: trackRef,
    });
    track.states.forEach((state) => {
      const reference = {
        namespace: "system" as const,
        systemId: record.id,
        kind: "state" as const,
        targetId: state.id,
      };
      options.push({
        value: referenceKey(reference),
        label: `${state.name} · 状态`,
        reference,
      });
    });
    track.transitions.forEach((transition) => {
      const reference = {
        namespace: "system" as const,
        systemId: record.id,
        kind: "transition" as const,
        targetId: transition.id,
      };
      options.push({
        value: referenceKey(reference),
        label: `${transition.name} · 转换`,
        reference,
      });
    });
  });
  record.dimensions.forEach((dimension) => {
    const reference = {
      namespace: "system" as const,
      systemId: record.id,
      kind:
        dimension.category === "quality"
          ? ("quality-dimension" as const)
          : ("boundary-dimension" as const),
      targetId: dimension.id,
    };
    options.push({
      value: referenceKey(reference),
      label: `${dimension.name} · ${dimension.category === "quality" ? "质量维度" : "边界维度"}`,
      reference,
    });
  });
  return options;
}

function ReferenceSelect({
  value,
  options,
  onChange,
}: {
  readonly value: PowerEntityReference;
  readonly options: readonly ReferenceOption[];
  readonly onChange: (reference: PowerEntityReference) => void;
}) {
  return (
    <CustomSelect
      value={referenceKey(value)}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
      }))}
      onChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onChange(option.reference);
      }}
      size="toolbar"
    />
  );
}

function ConditionGroupEditor({
  label,
  group,
  referenceOptions,
  onChange,
}: {
  readonly label: string;
  readonly group: PowerConditionGroup;
  readonly referenceOptions: readonly ReferenceOption[];
  readonly onChange: (group: PowerConditionGroup) => void;
}) {
  const updateClause = (id: string, patch: Partial<PowerConditionClause>) =>
    onChange({
      ...group,
      clauses: group.clauses.map((clause) =>
        clause.id === id ? { ...clause, ...patch } : clause,
      ),
    });
  return (
    <div className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--ink-muted)]">
          {label}
        </span>
        <CustomSelect
          value={group.mode}
          options={[
            { value: "all", label: "满足全部" },
            { value: "any", label: "满足任一" },
          ]}
          onChange={(mode) =>
            onChange({ ...group, mode: mode as PowerConditionGroup["mode"] })
          }
          size="toolbar"
        />
      </div>
      {group.clauses.map((clause) => (
        <div
          key={clause.id}
          className="space-y-1.5 border-l-2 border-[var(--line-strong)] pl-2"
        >
          <div className="grid grid-cols-[1fr_2rem] gap-1.5">
            <CustomSelect
              value={
                clause.subjectRef ? referenceKey(clause.subjectRef) : "__text__"
              }
              options={[
                { value: "__text__", label: "自由条件对象" },
                ...referenceOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                })),
              ]}
              onChange={(next) =>
                updateClause(clause.id, {
                  subjectRef:
                    next === "__text__"
                      ? null
                      : (referenceOptions.find(
                          (option) => option.value === next,
                        )?.reference ?? null),
                })
              }
              size="toolbar"
            />
            <button
              type="button"
              title="删除条件"
              onClick={() =>
                onChange({
                  ...group,
                  clauses: group.clauses.filter(
                    (candidate) => candidate.id !== clause.id,
                  ),
                })
              }
              className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <input
            className={inputClass}
            value={clause.subject}
            placeholder="对象或事实"
            onChange={(event) =>
              updateClause(clause.id, { subject: event.target.value })
            }
          />
          <div className="grid grid-cols-[1fr_7rem] gap-1.5">
            <input
              className={inputClass}
              value={clause.field}
              placeholder="属性，例如稳定性"
              onChange={(event) =>
                updateClause(clause.id, { field: event.target.value })
              }
            />
            <CustomSelect
              value={clause.operator}
              options={[
                ["equals", "等于"],
                ["not-equals", "不等于"],
                ["contains", "包含"],
                ["not-contains", "不包含"],
                ["greater-than", "大于"],
                ["less-than", "小于"],
                ["at-least", "至少"],
                ["at-most", "至多"],
                ["exists", "存在"],
                ["not-exists", "不存在"],
                ["matches", "符合"],
              ].map(([value, optionLabel]) => ({
                value,
                label: optionLabel,
              }))}
              onChange={(operator) =>
                updateClause(clause.id, {
                  operator: operator as PowerConditionClause["operator"],
                })
              }
              size="toolbar"
            />
          </div>
          <input
            className={inputClass}
            value={clause.value}
            placeholder="要求值"
            onChange={(event) =>
              updateClause(clause.id, { value: event.target.value })
            }
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            ...group,
            clauses: [
              ...group.clauses,
              {
                id: createId("condition"),
                subjectRef: null,
                subject: "",
                field: "",
                operator: "equals",
                value: "",
                note: "",
              },
            ],
          })
        }
        className="flex h-8 items-center gap-1 text-xs font-medium text-[var(--accent-warm)]"
      >
        <Plus className="h-3.5 w-3.5" /> 添加条件
      </button>
    </div>
  );
}

function MetricValuesEditor({
  label,
  dimensions,
  values,
  onChange,
}: {
  readonly label: string;
  readonly dimensions: readonly PowerMetricDimension[];
  readonly values: readonly PowerMetricValue[];
  readonly onChange: (values: PowerMetricValue[]) => void;
}) {
  return (
    <div className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
      <span className="text-xs font-semibold text-[var(--ink-muted)]">
        {label}
      </span>
      {dimensions.length === 0 ? (
        <p className="text-xs leading-5 text-[var(--ink-muted)]">
          先在“质量与边界”中创建维度。
        </p>
      ) : (
        dimensions.map((dimension) => {
          const current = values.find(
            (value) => value.dimensionId === dimension.id,
          );
          return (
            <div
              key={dimension.id}
              className="grid grid-cols-[7rem_1fr] items-center gap-2"
            >
              <span className="truncate text-xs text-[var(--ink-muted)]">
                {dimension.name}
              </span>
              <input
                className={inputClass}
                value={current?.value === null ? "" : (current?.value ?? "")}
                placeholder={dimension.unit || "值或描述"}
                onChange={(event) => {
                  const raw = event.target.value;
                  const nextValue: string | number | null =
                    raw === ""
                      ? null
                      : dimension.measurement === "numeric" &&
                          Number.isFinite(Number(raw))
                        ? Number(raw)
                        : raw;
                  onChange(
                    current
                      ? values.map((value) =>
                          value.dimensionId === dimension.id
                            ? { ...value, value: nextValue }
                            : value,
                        )
                      : [
                          ...values,
                          {
                            dimensionId: dimension.id,
                            value: nextValue,
                            note: "",
                          },
                        ],
                  );
                }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

function MetricModifiersEditor({
  label,
  dimensions,
  values,
  onChange,
}: {
  readonly label: string;
  readonly dimensions: readonly PowerMetricDimension[];
  readonly values: readonly PowerMetricModifier[];
  readonly onChange: (values: PowerMetricModifier[]) => void;
}) {
  return (
    <div className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--ink-muted)]">
          {label}
        </span>
        <button
          type="button"
          disabled={dimensions.length === 0}
          onClick={() => {
            const dimension = dimensions[0];
            if (!dimension) return;
            onChange([
              ...values,
              {
                dimensionId: dimension.id,
                operation: "add",
                value: "",
                note: "",
              },
            ]);
          }}
          className="text-xs font-medium text-[var(--accent-warm)] disabled:opacity-35"
        >
          + 添加
        </button>
      </div>
      {values.map((modifier, index) => (
        <div
          key={`${modifier.dimensionId}-${index}`}
          className="grid grid-cols-[1fr_5.5rem_1fr_2rem] gap-1.5"
        >
          <CustomSelect
            value={modifier.dimensionId}
            options={dimensions.map((dimension) => ({
              value: dimension.id,
              label: dimension.name,
            }))}
            onChange={(dimensionId) =>
              onChange(
                values.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, dimensionId } : item,
                ),
              )
            }
            size="toolbar"
          />
          <CustomSelect
            value={modifier.operation}
            options={[
              ["set", "设为"],
              ["add", "增加"],
              ["multiply", "乘以"],
              ["minimum", "下限"],
              ["maximum", "上限"],
            ].map(([value, optionLabel]) => ({
              value,
              label: optionLabel,
            }))}
            onChange={(operation) =>
              onChange(
                values.map((item, itemIndex) =>
                  itemIndex === index
                    ? {
                        ...item,
                        operation:
                          operation as PowerMetricModifier["operation"],
                      }
                    : item,
                ),
              )
            }
            size="toolbar"
          />
          <input
            className={inputClass}
            value={modifier.value}
            onChange={(event) =>
              onChange(
                values.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, value: event.target.value }
                    : item,
                ),
              )
            }
          />
          <button
            type="button"
            title="删除修正"
            onClick={() =>
              onChange(values.filter((_, itemIndex) => itemIndex !== index))
            }
            className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function CatalogCommonFields({
  entity,
  onChange,
}: {
  readonly entity: PowerCatalogEntity;
  readonly onChange: (entity: PowerCatalogEntity) => void;
}) {
  return (
    <>
      <Field label="名称">
        <input
          className={inputClass}
          value={entity.name}
          onChange={(event) =>
            onChange({ ...entity, name: event.target.value })
          }
        />
      </Field>
      <Field label="别名（逗号分隔）">
        <input
          className={inputClass}
          value={entity.aliases.join("，")}
          onChange={(event) =>
            onChange({ ...entity, aliases: commaList(event.target.value) })
          }
        />
      </Field>
      <Field label="自定义类型">
        <input
          className={inputClass}
          value={entity.subtypeId}
          onChange={(event) =>
            onChange({ ...entity, subtypeId: event.target.value })
          }
        />
      </Field>
      <Field label="摘要">
        <textarea
          className={textareaClass}
          value={entity.summary}
          onChange={(event) =>
            onChange({ ...entity, summary: event.target.value })
          }
        />
      </Field>
      <Field label="标签（逗号分隔）">
        <input
          className={inputClass}
          value={entity.tags.join("，")}
          onChange={(event) =>
            onChange({ ...entity, tags: commaList(event.target.value) })
          }
        />
      </Field>
    </>
  );
}

function TheoryOperationsEditor({
  operations,
  onChange,
}: {
  readonly operations: readonly PowerTheoryOperation[];
  readonly onChange: (operations: PowerTheoryOperation[]) => void;
}) {
  return (
    <div className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--ink-muted)]">
          基础操作
        </span>
        <button
          type="button"
          onClick={() =>
            onChange([
              ...operations,
              {
                id: createId("operation"),
                name: "新操作",
                operationType: "custom",
                input: "",
                output: "",
                rule: "",
              },
            ])
          }
          className="text-xs font-medium text-[var(--accent-warm)]"
        >
          + 添加
        </button>
      </div>
      {operations.map((operation, index) => (
        <div
          key={operation.id}
          className="space-y-1.5 border-l-2 border-[var(--line-strong)] pl-2"
        >
          <div className="grid grid-cols-[1fr_7rem_2rem] gap-1.5">
            <input
              className={inputClass}
              value={operation.name}
              onChange={(event) =>
                onChange(
                  operations.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, name: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <CustomSelect
              value={operation.operationType}
              options={[
                ["circulate", "循环"],
                ["aggregate", "聚合"],
                ["compress", "压缩"],
                ["refine", "提纯"],
                ["split", "分流"],
                ["convert", "转换"],
                ["resonate", "共振"],
                ["synchronize", "同步"],
                ["encode", "编码"],
                ["inscribe", "刻印"],
                ["project", "投射"],
                ["self-organize", "自组织"],
                ["feedback", "反馈"],
                ["sample", "采样"],
                ["custom", "自定义"],
              ].map(([value, optionLabel]) => ({
                value,
                label: optionLabel,
              }))}
              onChange={(operationType) =>
                onChange(
                  operations.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          operationType:
                            operationType as PowerTheoryOperation["operationType"],
                        }
                      : item,
                  ),
                )
              }
              size="toolbar"
            />
            <button
              type="button"
              title="删除操作"
              onClick={() =>
                onChange(
                  operations.filter((_, itemIndex) => itemIndex !== index),
                )
              }
              className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <input
              className={inputClass}
              value={operation.input}
              placeholder="输入"
              onChange={(event) =>
                onChange(
                  operations.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, input: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <input
              className={inputClass}
              value={operation.output}
              placeholder="输出"
              onChange={(event) =>
                onChange(
                  operations.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, output: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </div>
          <textarea
            className={textareaClass}
            value={operation.rule}
            placeholder="操作规则"
            onChange={(event) =>
              onChange(
                operations.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, rule: event.target.value }
                    : item,
                ),
              )
            }
          />
        </div>
      ))}
    </div>
  );
}

function CatalogInspector({
  entity,
  catalog,
  referenceOptions,
  onChange,
  onDelete,
}: {
  readonly entity: PowerCatalogEntity;
  readonly catalog: PowerCatalog;
  readonly referenceOptions: readonly ReferenceOption[];
  readonly onChange: (entity: PowerCatalogEntity) => void;
  readonly onDelete: () => void;
}) {
  return (
    <>
      <InspectorHeader
        eyebrow={CATALOG_KIND_LABELS[entity.kind]}
        title={entity.name}
        onDelete={onDelete}
      />
      <div className="space-y-3 p-4">
        <CatalogCommonFields entity={entity} onChange={onChange} />
        {entity.kind === "foundation" && (
          <>
            <Field label="本源类型">
              <CustomSelect
                value={entity.foundationType}
                options={[
                  ["natural", "自然"],
                  ["biological", "生物"],
                  ["psychic", "精神"],
                  ["divine", "神性"],
                  ["technological", "科技"],
                  ["social", "社会制度"],
                  ["conceptual", "概念"],
                  ["extradimensional", "异维度"],
                  ["unknown", "未知"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(foundationType) =>
                  onChange({
                    ...entity,
                    foundationType:
                      foundationType as PowerFoundation["foundationType"],
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="可获得范围">
              <CustomSelect
                value={entity.availability}
                options={[
                  ["universal", "普遍存在"],
                  ["regional", "区域限定"],
                  ["innate", "先天"],
                  ["granted", "授予"],
                  ["manufactured", "制造"],
                  ["institutional", "制度"],
                  ["event-bound", "事件限定"],
                  ["unknown", "未知"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(availability) =>
                  onChange({
                    ...entity,
                    availability:
                      availability as PowerFoundation["availability"],
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="显现方式">
              <textarea
                className={textareaClass}
                value={entity.manifestation}
                onChange={(event) =>
                  onChange({ ...entity, manifestation: event.target.value })
                }
              />
            </Field>
          </>
        )}
        {entity.kind === "medium" && (
          <>
            <Field label="介质类型">
              <CustomSelect
                value={entity.mediumType}
                options={[
                  ["energy", "能量"],
                  ["substance", "物质"],
                  ["field", "场"],
                  ["network", "网络"],
                  ["body", "身体"],
                  ["mind", "精神"],
                  ["soul", "灵魂"],
                  ["symbolic", "符号"],
                  ["device", "设备"],
                  ["authority", "权限"],
                  ["environment", "环境"],
                  ["unknown", "未知"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(mediumType) =>
                  onChange({
                    ...entity,
                    mediumType: mediumType as PowerMedium["mediumType"],
                  })
                }
                size="toolbar"
              />
            </Field>
            {[
              ["carrier", "承载结构"],
              ["circulation", "运行与循环"],
              ["storage", "储存方式"],
              ["loss", "损耗与逸散"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <textarea
                  className={textareaClass}
                  value={entity[key as keyof PowerMedium] as string}
                  onChange={(event) =>
                    onChange({ ...entity, [key]: event.target.value })
                  }
                />
              </Field>
            ))}
          </>
        )}
        {entity.kind === "principle" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="法则类型">
                <CustomSelect
                  value={entity.principleType}
                  options={[
                    ["invariant", "不变量"],
                    ["prohibition", "禁则"],
                    ["boundary", "边界"],
                    ["conversion", "转换"],
                    ["priority", "优先级"],
                    ["axiom", "公理"],
                    ["custom", "自定义"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(principleType) =>
                    onChange({
                      ...entity,
                      principleType:
                        principleType as PowerPrinciple["principleType"],
                    })
                  }
                  size="toolbar"
                />
              </Field>
              <Field label="作用域">
                <CustomSelect
                  value={entity.scope}
                  options={[
                    ["universe", "宇宙"],
                    ["world", "世界"],
                    ["domain", "领域"],
                    ["system", "体系"],
                    ["local", "局部"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(scope) =>
                    onChange({
                      ...entity,
                      scope: scope as PowerPrinciple["scope"],
                    })
                  }
                  size="toolbar"
                />
              </Field>
            </div>
            <Field label="法则陈述（每行一项）">
              <textarea
                className={textareaClass}
                value={entity.statements.join("\n")}
                onChange={(event) =>
                  onChange({ ...entity, statements: lines(event.target.value) })
                }
              />
            </Field>
            <Field label="成立条件（每行一项）">
              <textarea
                className={textareaClass}
                value={entity.conditions.join("\n")}
                onChange={(event) =>
                  onChange({ ...entity, conditions: lines(event.target.value) })
                }
              />
            </Field>
            <Field label="例外（每行一项）">
              <textarea
                className={textareaClass}
                value={entity.exceptions.join("\n")}
                onChange={(event) =>
                  onChange({ ...entity, exceptions: lines(event.target.value) })
                }
              />
            </Field>
          </>
        )}
        {entity.kind === "resource" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="资源类型">
                <CustomSelect
                  value={entity.resourceType}
                  options={[
                    ["fuel", "燃料"],
                    ["material", "材料"],
                    ["catalyst", "催化剂"],
                    ["environment", "环境"],
                    ["information", "信息"],
                    ["permission", "权限"],
                    ["emotion", "情绪"],
                    ["biological", "生物"],
                    ["time", "时间"],
                    ["other", "其它"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(resourceType) =>
                    onChange({
                      ...entity,
                      resourceType:
                        resourceType as PowerResource["resourceType"],
                    })
                  }
                  size="toolbar"
                />
              </Field>
              <Field label="计量方式">
                <CustomSelect
                  value={entity.measurement}
                  options={[
                    ["numeric", "数值"],
                    ["ordinal", "等级"],
                    ["descriptive", "描述"],
                    ["unknown", "未知"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(measurement) =>
                    onChange({
                      ...entity,
                      measurement: measurement as PowerResource["measurement"],
                    })
                  }
                  size="toolbar"
                />
              </Field>
            </div>
            <Field label="单位">
              <input
                className={inputClass}
                value={entity.unit}
                onChange={(event) =>
                  onChange({ ...entity, unit: event.target.value })
                }
              />
            </Field>
            <Field label="质量维度（每行一项）">
              <textarea
                className={textareaClass}
                value={entity.qualityDimensions.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...entity,
                    qualityDimensions: lines(event.target.value),
                  })
                }
              />
            </Field>
            <Field label="补充方式">
              <textarea
                className={textareaClass}
                value={entity.replenishment}
                onChange={(event) =>
                  onChange({ ...entity, replenishment: event.target.value })
                }
              />
            </Field>
            <Field label="稀缺性">
              <textarea
                className={textareaClass}
                value={entity.scarcity}
                onChange={(event) =>
                  onChange({ ...entity, scarcity: event.target.value })
                }
              />
            </Field>
          </>
        )}
        {entity.kind === "theory" && (
          <>
            <Field label="表达模型">
              <CustomSelect
                value={entity.representationType}
                options={[
                  ["sequence", "顺序路径"],
                  ["graph", "图网络"],
                  ["modular", "模块与子程序"],
                  ["spatial-field", "空间场"],
                  ["symbolic", "符号与咒式"],
                  ["dynamic-system", "动态系统"],
                  ["rule-system", "演化规则"],
                  ["probabilistic", "概率模型"],
                  ["embodied", "身体动作"],
                  ["emotional", "情绪结构"],
                  ["unknown", "未知"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(representationType) =>
                  onChange({
                    ...entity,
                    representationType:
                      representationType as PowerTheory["representationType"],
                  })
                }
                size="toolbar"
              />
            </Field>
            <div className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--ink-muted)]">
                  操作载体
                </span>
                <button
                  type="button"
                  disabled={referenceOptions.length === 0}
                  onClick={() => {
                    const option = referenceOptions[0];
                    if (option) {
                      onChange({
                        ...entity,
                        substrateRefs: [
                          ...entity.substrateRefs,
                          option.reference,
                        ],
                      });
                    }
                  }}
                  className="text-xs font-medium text-[var(--accent-warm)] disabled:opacity-35"
                >
                  + 添加
                </button>
              </div>
              {entity.substrateRefs.map((reference, index) => (
                <div
                  key={`${referenceKey(reference)}-${index}`}
                  className="grid grid-cols-[1fr_2rem] gap-1.5"
                >
                  <ReferenceSelect
                    value={reference}
                    options={referenceOptions}
                    onChange={(next) =>
                      onChange({
                        ...entity,
                        substrateRefs: entity.substrateRefs.map(
                          (item, itemIndex) =>
                            itemIndex === index ? next : item,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    title="删除载体"
                    onClick={() =>
                      onChange({
                        ...entity,
                        substrateRefs: entity.substrateRefs.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                    className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="空间维度">
                <input
                  type="number"
                  min={0}
                  max={16}
                  className={inputClass}
                  value={entity.topology.spatialDimensions ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...entity,
                      topology: {
                        ...entity.topology,
                        spatialDimensions:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="控制策略">
                <input
                  className={inputClass}
                  value={entity.controlStrategy}
                  onChange={(event) =>
                    onChange({
                      ...entity,
                      controlStrategy: event.target.value,
                    })
                  }
                />
              </Field>
            </div>
            <Field label="节点定义">
              <textarea
                className={textareaClass}
                value={entity.topology.nodeDefinition}
                onChange={(event) =>
                  onChange({
                    ...entity,
                    topology: {
                      ...entity.topology,
                      nodeDefinition: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="连接与整体结构">
              <textarea
                className={textareaClass}
                value={`${entity.topology.connectionDefinition}${
                  entity.topology.structure
                    ? `\n\n${entity.topology.structure}`
                    : ""
                }`}
                onChange={(event) =>
                  onChange({
                    ...entity,
                    topology: {
                      ...entity.topology,
                      structure: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <TheoryOperationsEditor
              operations={entity.operations}
              onChange={(operations) => onChange({ ...entity, operations })}
            />
            <div className="grid grid-cols-2 gap-2">
              {(
                ["memory", "parallelism", "abstraction", "dynamism"] as const
              ).map((key) => (
                <Field
                  key={key}
                  label={
                    key === "memory"
                      ? "记忆负荷"
                      : key === "parallelism"
                        ? "并行负荷"
                        : key === "abstraction"
                          ? "抽象负荷"
                          : "动态负荷"
                  }
                >
                  <CustomSelect
                    value={entity.complexity[key]}
                    options={[
                      ["low", "低"],
                      ["medium", "中"],
                      ["high", "高"],
                      ["extreme", "极限"],
                      ["unknown", "未知"],
                    ].map(([value, label]) => ({ value, label }))}
                    onChange={(value) =>
                      onChange({
                        ...entity,
                        complexity: {
                          ...entity.complexity,
                          [key]: value,
                        },
                      })
                    }
                    size="toolbar"
                  />
                </Field>
              ))}
            </div>
            {[
              ["assumptions", "成立假设"],
              ["invariants", "不变量"],
              ["failureModes", "失败模式"],
            ].map(([key, label]) => (
              <Field key={key} label={`${label}（每行一项）`}>
                <textarea
                  className={textareaClass}
                  value={(entity[key as keyof PowerTheory] as string[]).join(
                    "\n",
                  )}
                  onChange={(event) =>
                    onChange({ ...entity, [key]: lines(event.target.value) })
                  }
                />
              </Field>
            ))}
          </>
        )}
        {entity.kind === "method" && (
          <>
            <Field label="获得方式">
              <CustomSelect
                value={entity.acquisition}
                options={[
                  ["training", "训练"],
                  ["study", "学习"],
                  ["inheritance", "继承"],
                  ["awakening", "觉醒"],
                  ["implantation", "植入"],
                  ["contract", "契约"],
                  ["ritual", "仪式"],
                  ["equipment", "装备"],
                  ["authorization", "授权"],
                  ["event", "事件"],
                  ["unknown", "未知"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(acquisition) =>
                  onChange({
                    ...entity,
                    acquisition: acquisition as PowerMethod["acquisition"],
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="用途（逗号分隔）">
              <input
                className={inputClass}
                value={entity.roles.join("，")}
                placeholder="advance, refine, control"
                onChange={(event) =>
                  onChange({
                    ...entity,
                    roles: commaList(event.target.value).filter((role) =>
                      [
                        "advance",
                        "stabilize",
                        "refine",
                        "recover",
                        "transform",
                        "awaken",
                        "control",
                        "adapt",
                      ].includes(role),
                    ) as PowerMethod["roles"],
                  })
                }
              />
            </Field>
            <div className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--ink-muted)]">
                  理论基础
                </span>
                <button
                  type="button"
                  disabled={catalog.theories.length === 0}
                  onClick={() => {
                    const theory = catalog.theories[0];
                    if (!theory) return;
                    onChange({
                      ...entity,
                      theoryRefs: [
                        ...entity.theoryRefs,
                        {
                          namespace: "catalog",
                          kind: "theory",
                          targetId: theory.id,
                        },
                      ],
                    });
                  }}
                  className="text-xs font-medium text-[var(--accent-warm)] disabled:opacity-35"
                >
                  + 关联理论
                </button>
              </div>
              {entity.theoryRefs.map((reference, index) => (
                <div
                  key={`${reference.targetId}-${index}`}
                  className="grid grid-cols-[1fr_2rem] gap-1.5"
                >
                  <CustomSelect
                    value={reference.targetId}
                    options={catalog.theories.map((theory) => ({
                      value: theory.id,
                      label: theory.name,
                    }))}
                    onChange={(targetId) =>
                      onChange({
                        ...entity,
                        theoryRefs: entity.theoryRefs.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, targetId } : item,
                        ),
                      })
                    }
                    size="toolbar"
                  />
                  <button
                    type="button"
                    title="解除理论关联"
                    onClick={() =>
                      onChange({
                        ...entity,
                        theoryRefs: entity.theoryRefs.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                    className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <Field label="执行过程">
              <textarea
                className={textareaClass}
                value={entity.procedure}
                onChange={(event) =>
                  onChange({ ...entity, procedure: event.target.value })
                }
              />
            </Field>
            <div className="space-y-2 border-t border-[var(--line-subtle)] pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--ink-muted)]">
                  方法阶段
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...entity,
                      phases: [
                        ...entity.phases,
                        {
                          id: createId("phase"),
                          name: `阶段 ${entity.phases.length + 1}`,
                          order: entity.phases.length,
                          goal: "",
                          operations: [],
                          requirements: [],
                          outputs: [],
                        },
                      ],
                    })
                  }
                  className="text-xs font-medium text-[var(--accent-warm)]"
                >
                  + 添加
                </button>
              </div>
              {entity.phases.map((phase, index) => (
                <div
                  key={phase.id}
                  className="space-y-1.5 border-l-2 border-[var(--line-strong)] pl-2"
                >
                  <div className="grid grid-cols-[1fr_2rem] gap-1.5">
                    <input
                      className={inputClass}
                      value={phase.name}
                      onChange={(event) =>
                        onChange({
                          ...entity,
                          phases: entity.phases.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, name: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      title="删除阶段"
                      onClick={() =>
                        onChange({
                          ...entity,
                          phases: entity.phases.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                      className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <textarea
                    className={textareaClass}
                    value={phase.goal}
                    placeholder="阶段目标"
                    onChange={(event) =>
                      onChange({
                        ...entity,
                        phases: entity.phases.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, goal: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <Field label="产出（每行一项）">
              <textarea
                className={textareaClass}
                value={entity.outputs.join("\n")}
                onChange={(event) =>
                  onChange({ ...entity, outputs: lines(event.target.value) })
                }
              />
            </Field>
            <Field label="失败后果（每行一项）">
              <textarea
                className={textareaClass}
                value={entity.failureConsequences.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...entity,
                    failureConsequences: lines(event.target.value),
                  })
                }
              />
            </Field>
          </>
        )}
        {entity.kind === "capability" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="能力类型">
                <CustomSelect
                  value={entity.capabilityType}
                  options={[
                    ["intrinsic", "基础能力"],
                    ["technique", "技巧"],
                    ["spell", "法术"],
                    ["superpower", "异能"],
                    ["sense", "感知"],
                    ["transformation", "变形"],
                    ["authority", "权能"],
                    ["technology", "科技能力"],
                    ["custom", "自定义"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(capabilityType) =>
                    onChange({
                      ...entity,
                      capabilityType:
                        capabilityType as PowerCapability["capabilityType"],
                    })
                  }
                  size="toolbar"
                />
              </Field>
              <Field label="激活方式">
                <CustomSelect
                  value={entity.activation}
                  options={[
                    ["active", "主动"],
                    ["passive", "被动"],
                    ["conditional", "条件"],
                    ["toggle", "切换"],
                    ["ritual", "仪式"],
                    ["collective", "集体"],
                    ["automatic", "自动"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(activation) =>
                    onChange({
                      ...entity,
                      activation: activation as PowerCapability["activation"],
                    })
                  }
                  size="toolbar"
                />
              </Field>
            </div>
            {[
              ["effect", "效果"],
              ["target", "目标"],
              ["range", "范围"],
              ["duration", "持续时间"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <textarea
                  className={textareaClass}
                  value={entity[key as keyof PowerCapability] as string}
                  onChange={(event) =>
                    onChange({ ...entity, [key]: event.target.value })
                  }
                />
              </Field>
            ))}
            {[
              ["costs", "成本"],
              ["limitations", "限制"],
              ["sideEffects", "副作用"],
              ["countermeasures", "反制方式"],
            ].map(([key, label]) => (
              <Field key={key} label={`${label}（每行一项）`}>
                <textarea
                  className={textareaClass}
                  value={(
                    entity[key as keyof PowerCapability] as string[]
                  ).join("\n")}
                  onChange={(event) =>
                    onChange({ ...entity, [key]: lines(event.target.value) })
                  }
                />
              </Field>
            ))}
          </>
        )}
        <MetadataFields
          value={entity.metadata}
          onChange={(metadata) => onChange({ ...entity, metadata })}
        />
      </div>
    </>
  );
}

function findCatalogEntity(
  catalog: PowerCatalog,
  id: string,
): PowerCatalogEntity | undefined {
  return [
    ...catalog.foundations,
    ...catalog.mediums,
    ...catalog.principles,
    ...catalog.resources,
    ...catalog.theories,
    ...catalog.methods,
    ...catalog.capabilities,
  ].find((entity) => entity.id === id);
}

function replaceCatalogEntity(
  catalog: PowerCatalog,
  entity: PowerCatalogEntity,
): PowerCatalog {
  return {
    ...catalog,
    foundations:
      entity.kind === "foundation"
        ? catalog.foundations.map((item) =>
            item.id === entity.id ? entity : item,
          )
        : catalog.foundations,
    mediums:
      entity.kind === "medium"
        ? catalog.mediums.map((item) => (item.id === entity.id ? entity : item))
        : catalog.mediums,
    principles:
      entity.kind === "principle"
        ? catalog.principles.map((item) =>
            item.id === entity.id ? entity : item,
          )
        : catalog.principles,
    resources:
      entity.kind === "resource"
        ? catalog.resources.map((item) =>
            item.id === entity.id ? entity : item,
          )
        : catalog.resources,
    theories:
      entity.kind === "theory"
        ? catalog.theories.map((item) =>
            item.id === entity.id ? entity : item,
          )
        : catalog.theories,
    methods:
      entity.kind === "method"
        ? catalog.methods.map((item) => (item.id === entity.id ? entity : item))
        : catalog.methods,
    capabilities:
      entity.kind === "capability"
        ? catalog.capabilities.map((item) =>
            item.id === entity.id ? entity : item,
          )
        : catalog.capabilities,
  };
}

function StateInspector({
  state,
  record,
  referenceOptions,
  onChange,
  onDelete,
}: {
  readonly state: PowerProgressionState;
  readonly record: PowerSystemRecord;
  readonly referenceOptions: readonly ReferenceOption[];
  readonly onChange: (state: PowerProgressionState) => void;
  readonly onDelete: () => void;
}) {
  const qualityDimensions = record.dimensions.filter(
    (dimension) => dimension.category === "quality",
  );
  const boundaryDimensions = record.dimensions.filter(
    (dimension) => dimension.category === "boundary",
  );
  return (
    <>
      <InspectorHeader
        eyebrow="成长状态"
        title={state.name}
        onDelete={onDelete}
      />
      <div className="space-y-3 p-4">
        <Field label="名称">
          <input
            className={inputClass}
            value={state.name}
            onChange={(event) =>
              onChange({ ...state, name: event.target.value })
            }
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="状态类型">
            <CustomSelect
              value={state.stateType}
              options={[
                ["stage", "境界/阶段"],
                ["rank", "等级"],
                ["form", "形态"],
                ["control", "控制阶段"],
                ["version", "版本"],
                ["permission", "权限"],
                ["condition", "状态"],
                ["custom", "自定义"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(stateType) =>
                onChange({
                  ...state,
                  stateType: stateType as PowerProgressionState["stateType"],
                })
              }
              size="toolbar"
            />
          </Field>
          <Field label="顺序">
            <input
              type="number"
              min={0}
              className={inputClass}
              value={state.order}
              onChange={(event) =>
                onChange({ ...state, order: Number(event.target.value) || 0 })
              }
            />
          </Field>
        </div>
        <Field label="摘要">
          <textarea
            className={textareaClass}
            value={state.summary}
            onChange={(event) =>
              onChange({ ...state, summary: event.target.value })
            }
          />
        </Field>
        <ConditionGroupEditor
          label="进入条件"
          group={state.contract.entryConditions}
          referenceOptions={referenceOptions}
          onChange={(entryConditions) =>
            onChange({
              ...state,
              contract: { ...state.contract, entryConditions },
            })
          }
        />
        <ConditionGroupEditor
          label="维持条件"
          group={state.contract.maintenanceConditions}
          referenceOptions={referenceOptions}
          onChange={(maintenanceConditions) =>
            onChange({
              ...state,
              contract: { ...state.contract, maintenanceConditions },
            })
          }
        />
        <ConditionGroupEditor
          label="离开 / 突破条件"
          group={state.contract.exitConditions}
          referenceOptions={referenceOptions}
          onChange={(exitConditions) =>
            onChange({
              ...state,
              contract: { ...state.contract, exitConditions },
            })
          }
        />
        <MetricValuesEditor
          label="基础质量"
          dimensions={qualityDimensions}
          values={state.contract.baseQualities}
          onChange={(baseQualities) =>
            onChange({
              ...state,
              contract: { ...state.contract, baseQualities },
            })
          }
        />
        <MetricValuesEditor
          label="基础能力边界"
          dimensions={boundaryDimensions}
          values={state.contract.baseBoundaries}
          onChange={(baseBoundaries) =>
            onChange({
              ...state,
              contract: { ...state.contract, baseBoundaries },
            })
          }
        />
        <div className="space-y-3 border-t border-[var(--line-subtle)] pt-3">
          <span className="text-xs font-semibold text-[var(--ink-muted)]">
            认知与控制模型
          </span>
          <Field label="表达模式">
            <CustomSelect
              value={state.contract.cognition.representationType}
              options={[
                ["sequence", "顺序路径"],
                ["graph", "图网络"],
                ["modular", "模块算法"],
                ["spatial-field", "空间场"],
                ["symbolic", "符号系统"],
                ["dynamic-system", "动态系统"],
                ["rule-system", "演化规则"],
                ["probabilistic", "概率模型"],
                ["embodied", "身体控制"],
                ["emotional", "情绪控制"],
                ["unknown", "未知"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(representationType) =>
                onChange({
                  ...state,
                  contract: {
                    ...state.contract,
                    cognition: {
                      ...state.contract.cognition,
                      representationType:
                        representationType as PowerProgressionState["contract"]["cognition"]["representationType"],
                    },
                  },
                })
              }
              size="toolbar"
            />
          </Field>
          <Field label="模型说明">
            <textarea
              className={textareaClass}
              value={state.contract.cognition.description}
              onChange={(event) =>
                onChange({
                  ...state,
                  contract: {
                    ...state.contract,
                    cognition: {
                      ...state.contract.cognition,
                      description: event.target.value,
                    },
                  },
                })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            {(
              ["memoryLoad", "parallelism", "abstraction", "dynamism"] as const
            ).map((key) => (
              <Field
                key={key}
                label={
                  key === "memoryLoad"
                    ? "记忆负荷"
                    : key === "parallelism"
                      ? "并行负荷"
                      : key === "abstraction"
                        ? "抽象负荷"
                        : "动态负荷"
                }
              >
                <CustomSelect
                  value={state.contract.cognition[key]}
                  options={[
                    ["low", "低"],
                    ["medium", "中"],
                    ["high", "高"],
                    ["extreme", "极限"],
                    ["unknown", "未知"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(value) =>
                    onChange({
                      ...state,
                      contract: {
                        ...state.contract,
                        cognition: {
                          ...state.contract.cognition,
                          [key]: value,
                        },
                      },
                    })
                  }
                  size="toolbar"
                />
              </Field>
            ))}
          </div>
          <Field label="所需技能（每行一项）">
            <textarea
              className={textareaClass}
              value={state.contract.cognition.requiredSkills.join("\n")}
              onChange={(event) =>
                onChange({
                  ...state,
                  contract: {
                    ...state.contract,
                    cognition: {
                      ...state.contract.cognition,
                      requiredSkills: lines(event.target.value),
                    },
                  },
                })
              }
            />
          </Field>
          <Field label="认知跃迁">
            <textarea
              className={textareaClass}
              value={state.contract.cognition.breakthroughInsight}
              onChange={(event) =>
                onChange({
                  ...state,
                  contract: {
                    ...state.contract,
                    cognition: {
                      ...state.contract.cognition,
                      breakthroughInsight: event.target.value,
                    },
                  },
                })
              }
            />
          </Field>
        </div>
        <Field label="稳定机制">
          <textarea
            className={textareaClass}
            value={state.contract.stability}
            onChange={(event) =>
              onChange({
                ...state,
                contract: { ...state.contract, stability: event.target.value },
              })
            }
          />
        </Field>
        <Field label="风险（每行一项）">
          <textarea
            className={textareaClass}
            value={state.contract.risks.join("\n")}
            onChange={(event) =>
              onChange({
                ...state,
                contract: {
                  ...state.contract,
                  risks: lines(event.target.value),
                },
              })
            }
          />
        </Field>
        <MetadataFields
          value={state.metadata}
          onChange={(metadata) => onChange({ ...state, metadata })}
        />
      </div>
    </>
  );
}

function ConnectionInspector({
  connection,
  record,
  catalog,
  referenceOptions,
  onChange,
  onDelete,
}: {
  readonly connection: PowerConnection;
  readonly record: PowerSystemRecord;
  readonly catalog: PowerCatalog;
  readonly referenceOptions: readonly ReferenceOption[];
  readonly onChange: (connection: PowerConnection) => void;
  readonly onDelete: () => void;
}) {
  const sourceOptions = referenceOptions.filter((option) => {
    if (connection.kind === "method-application") {
      return (
        option.reference.namespace === "catalog" &&
        option.reference.kind === "method"
      );
    }
    if (connection.kind === "resource-requirement") {
      return (
        option.reference.namespace === "catalog" &&
        option.reference.kind === "resource"
      );
    }
    if (connection.kind === "system-interaction") {
      return (
        option.reference.namespace === "system" &&
        option.reference.kind === "system"
      );
    }
    return true;
  });
  const targetOptions = referenceOptions.filter((option) => {
    if (connection.kind === "method-application") {
      return (
        option.reference.namespace === "system" &&
        ["system", "state", "transition"].includes(option.reference.kind)
      );
    }
    if (connection.kind === "capability-access") {
      return (
        option.reference.namespace === "catalog" &&
        option.reference.kind === "capability"
      );
    }
    if (connection.kind === "system-interaction") {
      return (
        option.reference.namespace === "system" &&
        option.reference.kind === "system"
      );
    }
    return true;
  });
  return (
    <>
      <InspectorHeader
        eyebrow="生态连接"
        title={connection.kind}
        onDelete={onDelete}
      />
      <div className="space-y-3 p-4">
        <Field label="来源">
          <ReferenceSelect
            value={connection.source}
            options={sourceOptions}
            onChange={(source) => onChange({ ...connection, source })}
          />
        </Field>
        <Field label="目标">
          <ReferenceSelect
            value={connection.target}
            options={targetOptions}
            onChange={(target) => onChange({ ...connection, target })}
          />
        </Field>
        {connection.kind === "association" && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="关系">
              <CustomSelect
                value={connection.relation}
                options={[
                  ["governs", "治理"],
                  ["uses", "使用"],
                  ["adopts", "采用"],
                  ["expresses", "表达"],
                  ["requires", "要求"],
                  ["compatible-with", "兼容"],
                  ["counters", "反制"],
                  ["forbidden-by", "禁用"],
                  ["depends-on", "依赖"],
                  ["converts-into", "转换为"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(relation) =>
                  onChange({
                    ...connection,
                    relation: relation as typeof connection.relation,
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="兼容性">
              <CustomSelect
                value={connection.compatibility}
                options={[
                  ["native", "原生"],
                  ["adapted", "适配"],
                  ["conditional", "有条件"],
                  ["forbidden", "禁止"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(compatibility) =>
                  onChange({
                    ...connection,
                    compatibility:
                      compatibility as typeof connection.compatibility,
                  })
                }
                size="toolbar"
              />
            </Field>
          </div>
        )}
        {connection.kind === "method-application" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="用途">
                <CustomSelect
                  value={connection.role}
                  options={[
                    ["advance", "推进"],
                    ["stabilize", "稳固"],
                    ["refine", "提质"],
                    ["recover", "恢复"],
                    ["transform", "转化"],
                    ["awaken", "觉醒"],
                    ["control", "控制"],
                    ["adapt", "适配"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(role) =>
                    onChange({
                      ...connection,
                      role: role as typeof connection.role,
                    })
                  }
                  size="toolbar"
                />
              </Field>
              <Field label="兼容性">
                <CustomSelect
                  value={connection.compatibility}
                  options={[
                    ["native", "原生"],
                    ["adapted", "适配"],
                    ["conditional", "有条件"],
                    ["forbidden", "禁止"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(compatibility) =>
                    onChange({
                      ...connection,
                      compatibility:
                        compatibility as typeof connection.compatibility,
                    })
                  }
                  size="toolbar"
                />
              </Field>
            </div>
            <Field label="具体理论">
              <CustomSelect
                value={connection.theoryRef?.targetId ?? "__none__"}
                options={[
                  { value: "__none__", label: "沿用方法默认理论" },
                  ...catalog.theories.map((theory) => ({
                    value: theory.id,
                    label: theory.name,
                  })),
                ]}
                onChange={(targetId) =>
                  onChange({
                    ...connection,
                    theoryRef:
                      targetId === "__none__"
                        ? null
                        : {
                            namespace: "catalog",
                            kind: "theory",
                            targetId,
                          },
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="执行模型">
              <textarea
                className={textareaClass}
                value={connection.executionModel}
                onChange={(event) =>
                  onChange({
                    ...connection,
                    executionModel: event.target.value,
                  })
                }
              />
            </Field>
            <div className="grid grid-cols-[7rem_1fr] gap-2">
              <Field label="效率表达">
                <CustomSelect
                  value={connection.efficiency.mode}
                  options={[
                    ["qualitative", "定性"],
                    ["multiplier", "倍率"],
                    ["formula", "公式"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(mode) =>
                    onChange({
                      ...connection,
                      efficiency: {
                        ...connection.efficiency,
                        mode: mode as typeof connection.efficiency.mode,
                      },
                    })
                  }
                  size="toolbar"
                />
              </Field>
              <Field label="效率值 / 公式">
                <input
                  className={inputClass}
                  value={connection.efficiency.value ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...connection,
                      efficiency: {
                        ...connection.efficiency,
                        value: event.target.value || null,
                      },
                    })
                  }
                />
              </Field>
            </div>
            <MetricModifiersEditor
              label="质量影响"
              dimensions={record.dimensions.filter(
                (dimension) => dimension.category === "quality",
              )}
              values={connection.qualityEffects}
              onChange={(qualityEffects) =>
                onChange({ ...connection, qualityEffects })
              }
            />
            <MetricModifiersEditor
              label="边界影响"
              dimensions={record.dimensions.filter(
                (dimension) => dimension.category === "boundary",
              )}
              values={connection.boundaryEffects}
              onChange={(boundaryEffects) =>
                onChange({ ...connection, boundaryEffects })
              }
            />
            <Field label="产出（每行一项）">
              <textarea
                className={textareaClass}
                value={connection.outcomes.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...connection,
                    outcomes: lines(event.target.value),
                  })
                }
              />
            </Field>
            <Field label="失败模式（每行一项）">
              <textarea
                className={textareaClass}
                value={connection.failureModes.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...connection,
                    failureModes: lines(event.target.value),
                  })
                }
              />
            </Field>
          </>
        )}
        {connection.kind === "resource-requirement" && (
          <>
            <Field label="用途">
              <CustomSelect
                value={connection.purpose}
                options={[
                  ["develop", "发展"],
                  ["advance", "突破"],
                  ["maintain", "维持"],
                  ["activate", "激活"],
                  ["recover", "恢复"],
                  ["transform", "转化"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(purpose) =>
                  onChange({
                    ...connection,
                    purpose: purpose as typeof connection.purpose,
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="数量表达">
              <CustomSelect
                value={connection.amount.mode}
                options={[
                  ["numeric", "固定数值"],
                  ["range", "数值区间"],
                  ["rate", "供给速率"],
                  ["descriptive", "定性描述"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(mode) =>
                  onChange({
                    ...connection,
                    amount: {
                      ...connection.amount,
                      mode: mode as typeof connection.amount.mode,
                    },
                  })
                }
                size="toolbar"
              />
            </Field>
            <div className="grid grid-cols-3 gap-1.5">
              <Field label="最小量">
                <input
                  type="number"
                  className={inputClass}
                  value={connection.amount.minimum ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...connection,
                      amount: {
                        ...connection.amount,
                        minimum:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="最大量">
                <input
                  type="number"
                  className={inputClass}
                  value={connection.amount.maximum ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...connection,
                      amount: {
                        ...connection.amount,
                        maximum:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="单位">
                <input
                  className={inputClass}
                  value={connection.amount.unit}
                  onChange={(event) =>
                    onChange({
                      ...connection,
                      amount: {
                        ...connection.amount,
                        unit: event.target.value,
                      },
                    })
                  }
                />
              </Field>
            </div>
            <Field label="描述量 / 供给速率">
              <input
                className={inputClass}
                value={connection.amount.value}
                onChange={(event) =>
                  onChange({
                    ...connection,
                    amount: {
                      ...connection.amount,
                      value: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="质量要求">
              <textarea
                className={textareaClass}
                value={connection.quality}
                onChange={(event) =>
                  onChange({ ...connection, quality: event.target.value })
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
              <input
                type="checkbox"
                checked={connection.consumed}
                onChange={(event) =>
                  onChange({ ...connection, consumed: event.target.checked })
                }
              />
              使用后消耗
            </label>
            <Field label="资源不足后果">
              <textarea
                className={textareaClass}
                value={connection.shortageConsequence}
                onChange={(event) =>
                  onChange({
                    ...connection,
                    shortageConsequence: event.target.value,
                  })
                }
              />
            </Field>
          </>
        )}
        {connection.kind === "capability-access" && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="获得方式">
              <CustomSelect
                value={connection.accessMode}
                options={[
                  ["intrinsic", "自动获得"],
                  ["learnable", "允许学习"],
                  ["method-grant", "方法授予"],
                  ["awakening", "觉醒"],
                  ["equipped", "装备"],
                  ["contracted", "契约"],
                  ["authorized", "授权"],
                  ["conditional", "条件开放"],
                  ["forbidden", "禁止"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(accessMode) =>
                  onChange({
                    ...connection,
                    accessMode: accessMode as typeof connection.accessMode,
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="初始掌握">
              <CustomSelect
                value={connection.mastery}
                options={[
                  ["available", "仅开放"],
                  ["basic", "基础"],
                  ["proficient", "熟练"],
                  ["mastered", "精通"],
                  ["variable", "因人而异"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(mastery) =>
                  onChange({
                    ...connection,
                    mastery: mastery as typeof connection.mastery,
                  })
                }
                size="toolbar"
              />
            </Field>
          </div>
        )}
        {connection.kind === "system-interaction" && (
          <>
            <Field label="交互方式">
              <CustomSelect
                value={connection.interaction}
                options={[
                  ["compatible", "兼容"],
                  ["conversion", "转换"],
                  ["suppression", "压制"],
                  ["amplification", "放大"],
                  ["interference", "干扰"],
                  ["exclusion", "排斥"],
                  ["fusion", "融合"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(interaction) =>
                  onChange({
                    ...connection,
                    interaction: interaction as typeof connection.interaction,
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="作用结果">
              <textarea
                className={textareaClass}
                value={connection.effect}
                onChange={(event) =>
                  onChange({ ...connection, effect: event.target.value })
                }
              />
            </Field>
          </>
        )}
        <ConditionGroupEditor
          label="成立条件"
          group={connection.conditions}
          referenceOptions={referenceOptions}
          onChange={(conditions) => onChange({ ...connection, conditions })}
        />
        <Field label="说明">
          <textarea
            className={textareaClass}
            value={connection.note}
            onChange={(event) =>
              onChange({ ...connection, note: event.target.value })
            }
          />
        </Field>
        <MetadataFields
          value={connection.metadata}
          onChange={(metadata) => onChange({ ...connection, metadata })}
        />
      </div>
    </>
  );
}

export default function PowerSystemInspector({
  selection,
  record,
  catalog,
  connections,
  meta,
  index,
  onRecordChange,
  onCatalogChange,
  onConnectionsChange,
  onSelectionChange,
  onDeleteSelection,
}: PowerSystemInspectorProps) {
  const referenceOptions = buildReferenceOptions(record, catalog, index);
  if (selection.kind === "system") {
    return (
      <>
        <InspectorHeader eyebrow="力量体系" title={record.name} />
        <div className="space-y-3 p-4">
          <Field label="体系名称">
            <input
              className={inputClass}
              value={record.name}
              onChange={(event) =>
                onRecordChange({ ...record, name: event.target.value })
              }
            />
          </Field>
          <Field label="别名（逗号分隔）">
            <input
              className={inputClass}
              value={record.aliases.join("，")}
              onChange={(event) =>
                onRecordChange({
                  ...record,
                  aliases: commaList(event.target.value),
                })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="体系类型">
              <CustomSelect
                value={record.typeId}
                options={meta.systemTypes.map((type) => ({
                  value: type.id,
                  label: type.name,
                }))}
                onChange={(typeId) => onRecordChange({ ...record, typeId })}
                size="toolbar"
              />
            </Field>
            <Field label="状态">
              <CustomSelect
                value={record.status}
                options={[
                  { value: "draft", label: "草稿" },
                  { value: "active", label: "启用" },
                  { value: "archived", label: "归档" },
                ]}
                onChange={(status) =>
                  onRecordChange({
                    ...record,
                    status: status as PowerSystemRecord["status"],
                  })
                }
                size="toolbar"
              />
            </Field>
          </div>
          <Field label="体系摘要">
            <textarea
              className={textareaClass}
              value={record.summary}
              onChange={(event) =>
                onRecordChange({ ...record, summary: event.target.value })
              }
            />
          </Field>
          <div className="space-y-3 border-t border-[var(--line-subtle)] pt-3">
            <span className="text-xs font-semibold text-[var(--ink-muted)]">
              设计契约
            </span>
            <Field label="解释程度">
              <CustomSelect
                value={record.designContract.explanation}
                options={[
                  ["explicit", "明确解释"],
                  ["partial", "部分解释"],
                  ["mysterious", "刻意神秘"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(explanation) =>
                  onRecordChange({
                    ...record,
                    designContract: {
                      ...record.designContract,
                      explanation:
                        explanation as PowerSystemRecord["designContract"]["explanation"],
                    },
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="成长结构">
              <CustomSelect
                value={record.designContract.progression}
                options={[
                  ["none", "无成长轨道"],
                  ["single-track", "单轨"],
                  ["multi-track", "多轨"],
                  ["event-driven", "事件驱动"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(progression) =>
                  onRecordChange({
                    ...record,
                    designContract: {
                      ...record.designContract,
                      progression:
                        progression as PowerSystemRecord["designContract"]["progression"],
                    },
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="理论公开程度">
              <CustomSelect
                value={record.designContract.theoryPolicy}
                options={[
                  ["explicit", "理论明确"],
                  ["partial", "部分已知"],
                  ["unknown", "理论未知"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(theoryPolicy) =>
                  onRecordChange({
                    ...record,
                    designContract: {
                      ...record.designContract,
                      theoryPolicy:
                        theoryPolicy as PowerSystemRecord["designContract"]["theoryPolicy"],
                    },
                  })
                }
                size="toolbar"
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="代价政策">
                <CustomSelect
                  value={record.designContract.costPolicy}
                  options={[
                    ["required", "必须有代价"],
                    ["recommended", "建议有代价"],
                    ["optional", "代价可选"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(costPolicy) =>
                    onRecordChange({
                      ...record,
                      designContract: {
                        ...record.designContract,
                        costPolicy:
                          costPolicy as PowerSystemRecord["designContract"]["costPolicy"],
                      },
                    })
                  }
                  size="toolbar"
                />
              </Field>
              <Field label="比较方式">
                <CustomSelect
                  value={record.designContract.comparison}
                  options={[
                    ["stable", "稳定可比较"],
                    ["contextual", "依情境比较"],
                    ["incomparable", "不可直接比较"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(comparison) =>
                    onRecordChange({
                      ...record,
                      designContract: {
                        ...record.designContract,
                        comparison:
                          comparison as PowerSystemRecord["designContract"]["comparison"],
                      },
                    })
                  }
                  size="toolbar"
                />
              </Field>
            </div>
          </div>
          <MetadataFields
            value={record.metadata}
            onChange={(metadata) => onRecordChange({ ...record, metadata })}
          />
        </div>
      </>
    );
  }

  if (selection.kind === "catalog") {
    const entity = findCatalogEntity(catalog, selection.id);
    if (!entity) return null;
    return (
      <CatalogInspector
        entity={entity}
        catalog={catalog}
        referenceOptions={referenceOptions}
        onChange={(next) =>
          onCatalogChange(replaceCatalogEntity(catalog, next))
        }
        onDelete={onDeleteSelection}
      />
    );
  }

  if (selection.kind === "track") {
    const track = record.tracks.find((item) => item.id === selection.id);
    if (!track) return null;
    const update = (next: PowerProgressionTrack) =>
      onRecordChange({
        ...record,
        tracks: record.tracks.map((item) =>
          item.id === next.id ? next : item,
        ),
      });
    return (
      <>
        <InspectorHeader
          eyebrow="成长轨道"
          title={track.name}
          onDelete={onDeleteSelection}
        />
        <div className="space-y-3 p-4">
          <Field label="名称">
            <input
              className={inputClass}
              value={track.name}
              onChange={(event) =>
                update({ ...track, name: event.target.value })
              }
            />
          </Field>
          <Field label="轨道类型">
            <CustomSelect
              value={track.mode}
              options={[
                ["ordered", "有序"],
                ["branching", "分支"],
                ["coexisting", "可共存"],
                ["cyclic", "循环"],
                ["threshold", "阈值"],
                ["event-driven", "事件驱动"],
                ["unordered", "无序"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(mode) =>
                update({
                  ...track,
                  mode: mode as PowerProgressionTrack["mode"],
                })
              }
              size="toolbar"
            />
          </Field>
          <Field label="摘要">
            <textarea
              className={textareaClass}
              value={track.summary}
              onChange={(event) =>
                update({ ...track, summary: event.target.value })
              }
            />
          </Field>
          <MetadataFields
            value={track.metadata}
            onChange={(metadata) => update({ ...track, metadata })}
          />
        </div>
      </>
    );
  }

  if (selection.kind === "state") {
    const track = record.tracks.find((item) => item.id === selection.trackId);
    const state = track?.states.find((item) => item.id === selection.id);
    if (!track || !state) return null;
    return (
      <StateInspector
        state={state}
        record={record}
        referenceOptions={referenceOptions}
        onChange={(next) =>
          onRecordChange({
            ...record,
            tracks: record.tracks.map((item) =>
              item.id === track.id
                ? {
                    ...item,
                    states: item.states.map((candidate) =>
                      candidate.id === next.id ? next : candidate,
                    ),
                  }
                : item,
            ),
          })
        }
        onDelete={onDeleteSelection}
      />
    );
  }

  if (selection.kind === "transition") {
    const track = record.tracks.find((item) => item.id === selection.trackId);
    const transition = track?.transitions.find(
      (item) => item.id === selection.id,
    );
    if (!track || !transition) return null;
    const update = (next: PowerProgressionTransition) =>
      onRecordChange({
        ...record,
        tracks: record.tracks.map((item) =>
          item.id === track.id
            ? {
                ...item,
                transitions: item.transitions.map((candidate) =>
                  candidate.id === next.id ? next : candidate,
                ),
              }
            : item,
        ),
      });
    return (
      <>
        <InspectorHeader
          eyebrow="状态转换"
          title={transition.name}
          onDelete={onDeleteSelection}
        />
        <div className="space-y-3 p-4">
          <Field label="名称">
            <input
              className={inputClass}
              value={transition.name}
              onChange={(event) =>
                update({ ...transition, name: event.target.value })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="起点">
              <CustomSelect
                value={transition.fromStateId ?? "__entry__"}
                options={[
                  { value: "__entry__", label: "体系入口" },
                  ...track.states.map((state) => ({
                    value: state.id,
                    label: state.name,
                  })),
                ]}
                onChange={(fromStateId) =>
                  update({
                    ...transition,
                    fromStateId:
                      fromStateId === "__entry__" ? null : fromStateId,
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="目标">
              <CustomSelect
                value={transition.toStateId}
                options={track.states.map((state) => ({
                  value: state.id,
                  label: state.name,
                }))}
                onChange={(toStateId) => update({ ...transition, toStateId })}
                size="toolbar"
              />
            </Field>
          </div>
          <Field label="转换类型">
            <CustomSelect
              value={transition.transitionType}
              options={[
                ["advance", "推进"],
                ["branch", "分支"],
                ["merge", "合流"],
                ["regress", "退化"],
                ["transform", "转化"],
                ["recover", "恢复"],
                ["awaken", "觉醒"],
                ["event", "事件"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(transitionType) =>
                update({
                  ...transition,
                  transitionType:
                    transitionType as PowerProgressionTransition["transitionType"],
                })
              }
              size="toolbar"
            />
          </Field>
          <ConditionGroupEditor
            label="转换条件"
            group={transition.conditions}
            referenceOptions={referenceOptions}
            onChange={(conditions) => update({ ...transition, conditions })}
          />
          <Field label="质量继承">
            <CustomSelect
              value={transition.qualityCarryover}
              options={[
                ["preserve", "保留"],
                ["reset", "重置"],
                ["transform", "转化"],
                ["partial", "部分继承"],
                ["custom", "自定义"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(qualityCarryover) =>
                update({
                  ...transition,
                  qualityCarryover:
                    qualityCarryover as PowerProgressionTransition["qualityCarryover"],
                })
              }
              size="toolbar"
            />
          </Field>
          <Field label="质量规则">
            <textarea
              className={textareaClass}
              value={transition.qualityRule}
              onChange={(event) =>
                update({ ...transition, qualityRule: event.target.value })
              }
            />
          </Field>
          <Field label="成功结果（每行一项）">
            <textarea
              className={textareaClass}
              value={transition.outcomes.join("\n")}
              onChange={(event) =>
                update({ ...transition, outcomes: lines(event.target.value) })
              }
            />
          </Field>
          <Field label="失败结果（每行一项）">
            <textarea
              className={textareaClass}
              value={transition.failureModes.join("\n")}
              onChange={(event) =>
                update({
                  ...transition,
                  failureModes: lines(event.target.value),
                })
              }
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
            <input
              type="checkbox"
              checked={transition.reversible}
              onChange={(event) =>
                update({ ...transition, reversible: event.target.checked })
              }
            />
            允许逆向转换
          </label>
        </div>
      </>
    );
  }

  if (selection.kind === "dimension") {
    const dimension = record.dimensions.find(
      (item) => item.id === selection.id,
    );
    if (!dimension) return null;
    const update = (next: PowerMetricDimension) =>
      onRecordChange({
        ...record,
        dimensions: record.dimensions.map((item) =>
          item.id === next.id ? next : item,
        ),
      });
    return (
      <>
        <InspectorHeader
          eyebrow="质量与边界维度"
          title={dimension.name}
          onDelete={onDeleteSelection}
        />
        <div className="space-y-3 p-4">
          <Field label="名称">
            <input
              className={inputClass}
              value={dimension.name}
              onChange={(event) =>
                update({ ...dimension, name: event.target.value })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="类别">
              <CustomSelect
                value={dimension.category}
                options={[
                  { value: "quality", label: "质量" },
                  { value: "boundary", label: "边界" },
                ]}
                onChange={(category) =>
                  update({
                    ...dimension,
                    category: category as PowerMetricDimension["category"],
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="计量方式">
              <CustomSelect
                value={dimension.measurement}
                options={[
                  { value: "numeric", label: "数值" },
                  { value: "ordinal", label: "等级" },
                  { value: "descriptive", label: "描述" },
                ]}
                onChange={(measurement) =>
                  update({
                    ...dimension,
                    measurement:
                      measurement as PowerMetricDimension["measurement"],
                  })
                }
                size="toolbar"
              />
            </Field>
          </div>
          <Field label="单位">
            <input
              className={inputClass}
              value={dimension.unit}
              onChange={(event) =>
                update({ ...dimension, unit: event.target.value })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="低值说明">
              <input
                className={inputClass}
                value={dimension.lowLabel}
                onChange={(event) =>
                  update({ ...dimension, lowLabel: event.target.value })
                }
              />
            </Field>
            <Field label="高值说明">
              <input
                className={inputClass}
                value={dimension.highLabel}
                onChange={(event) =>
                  update({ ...dimension, highLabel: event.target.value })
                }
              />
            </Field>
          </div>
          <Field label="说明">
            <textarea
              className={textareaClass}
              value={dimension.description}
              onChange={(event) =>
                update({ ...dimension, description: event.target.value })
              }
            />
          </Field>
        </div>
      </>
    );
  }

  if (selection.kind === "connection") {
    const connection = connections.connections.find(
      (item) => item.id === selection.id,
    );
    if (!connection) return null;
    return (
      <ConnectionInspector
        connection={connection}
        record={record}
        catalog={catalog}
        referenceOptions={referenceOptions}
        onChange={(next) =>
          onConnectionsChange({
            ...connections,
            connections: connections.connections.map((item) =>
              item.id === next.id ? next : item,
            ),
          })
        }
        onDelete={onDeleteSelection}
      />
    );
  }

  onSelectionChange({ kind: "system" });
  return null;
}

export { findCatalogEntity, replaceCatalogEntity };
