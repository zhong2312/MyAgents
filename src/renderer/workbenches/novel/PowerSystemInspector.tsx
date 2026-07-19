import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { CustomSelect } from "@/workbench-sdk";

import { createDefaultPowerTruthMetadata } from "./powerSystemDefaults";
import type {
  CrossSystemInteraction,
  PowerBenchmark,
  PowerCapability,
  PowerConditionClause,
  PowerDimension,
  PowerElement,
  PowerMethod,
  PowerOrigin,
  PowerRelation,
  PowerResource,
  PowerRule,
  PowerState,
  PowerStateTrack,
  PowerSystemIndex,
  PowerSystemInteractions,
  PowerSystemMeta,
  PowerSystemRecord,
  PowerTruthMetadata,
} from "./powerSystemSchema";

export type PowerInspectorSelection =
  | { readonly kind: "system" }
  | { readonly kind: "element"; readonly id: string }
  | { readonly kind: "relation"; readonly id: string }
  | { readonly kind: "track"; readonly id: string }
  | { readonly kind: "state"; readonly trackId: string; readonly id: string }
  | {
      readonly kind: "transition";
      readonly trackId: string;
      readonly id: string;
    }
  | { readonly kind: "rule"; readonly id: string }
  | { readonly kind: "dimension"; readonly id: string }
  | { readonly kind: "benchmark"; readonly id: string }
  | { readonly kind: "interaction"; readonly id: string };

interface PowerSystemInspectorProps {
  readonly selection: PowerInspectorSelection;
  readonly record: PowerSystemRecord;
  readonly meta: PowerSystemMeta;
  readonly index: PowerSystemIndex;
  readonly interactions: PowerSystemInteractions;
  readonly onChange: (record: PowerSystemRecord) => void;
  readonly onInteractionsChange: (
    interactions: PowerSystemInteractions,
  ) => void;
  readonly onSelectionChange: (selection: PowerInspectorSelection) => void;
}

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]";
const textareaClass = `${inputClass} min-h-24 resize-y leading-5`;

const ELEMENT_LABELS: Readonly<Record<PowerElement["kind"], string>> = {
  origin: "力量来源",
  resource: "资源",
  method: "运用方式",
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
    <header className="flex min-h-14 items-center gap-3 border-b border-[var(--line-subtle)] px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-[var(--ink-muted)]">
          {eyebrow}
        </div>
        <h2 className="mt-0.5 truncate text-sm font-semibold text-[var(--ink)]">
          {title}
        </h2>
      </div>
      {onDelete && (
        <button
          type="button"
          title="删除"
          aria-label="删除当前项目"
          onClick={onDelete}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
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
        设定治理与可见性
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="设定层级">
            <input
              className={inputClass}
              value={value.settingLevel}
              placeholder="核心、区域、剧情..."
              onChange={(event) =>
                onChange({ ...value, settingLevel: event.target.value })
              }
            />
          </Field>
          <Field label="正文揭示阶段">
            <input
              className={inputClass}
              value={value.revealStage}
              placeholder="卷一、第20章..."
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
                domainCategories: event.target.value
                  .split(/[，,]/u)
                  .map((item) => item.trim())
                  .filter(Boolean),
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
                { value: "default", label: "默认规则" },
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
        <Field label="空间节点 ID（逗号分隔）">
          <input
            className={inputClass}
            value={value.spatialScopeIds.join(", ")}
            onChange={(event) =>
              onChange({
                ...value,
                spatialScopeIds: event.target.value
                  .split(/[,，]/u)
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <div className="border-t border-[var(--line-subtle)] pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
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
                      id: createId("source-ref"),
                      label: "新来源",
                      path: "",
                      anchor: "",
                      note: "",
                    },
                  ],
                })
              }
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
            >
              <Plus className="h-3.5 w-3.5" /> 添加来源
            </button>
          </div>
          <div className="space-y-3">
            {value.sourceRefs.map((source) => {
              const updateSource = (patch: Partial<typeof source>) =>
                onChange({
                  ...value,
                  sourceRefs: value.sourceRefs.map((candidate) =>
                    candidate.id === source.id
                      ? { ...candidate, ...patch }
                      : candidate,
                  ),
                });
              return (
                <div
                  key={source.id}
                  className="space-y-2 border-l-2 border-[var(--line-strong)] pl-3"
                >
                  <div className="grid grid-cols-[1fr_2rem] gap-2">
                    <input
                      className={inputClass}
                      value={source.label}
                      placeholder="来源名称"
                      onChange={(event) =>
                        updateSource({ label: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      title="删除来源"
                      onClick={() =>
                        onChange({
                          ...value,
                          sourceRefs: value.sourceRefs.filter(
                            (candidate) => candidate.id !== source.id,
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
                      updateSource({ path: event.target.value })
                    }
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className={inputClass}
                      value={source.anchor}
                      placeholder="章节或锚点"
                      onChange={(event) =>
                        updateSource({ anchor: event.target.value })
                      }
                    />
                    <input
                      className={inputClass}
                      value={source.note}
                      placeholder="引用说明"
                      onChange={(event) =>
                        updateSource({ note: event.target.value })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </details>
  );
}

function ElementInspector({
  element,
  onChange,
  onDelete,
}: {
  readonly element: PowerElement;
  readonly onChange: (element: PowerElement) => void;
  readonly onDelete: () => void;
}) {
  const common = (
    <>
      <Field label="名称">
        <input
          className={inputClass}
          value={element.name}
          onChange={(event) =>
            onChange({ ...element, name: event.target.value })
          }
        />
      </Field>
      <Field label="自定义类型">
        <input
          className={inputClass}
          value={element.subtypeId}
          placeholder="元素、装备、契约、变身..."
          onChange={(event) =>
            onChange({ ...element, subtypeId: event.target.value })
          }
        />
      </Field>
      <Field label="摘要">
        <textarea
          className={textareaClass}
          value={element.summary}
          onChange={(event) =>
            onChange({ ...element, summary: event.target.value })
          }
        />
      </Field>
    </>
  );

  return (
    <>
      <InspectorHeader
        eyebrow={ELEMENT_LABELS[element.kind]}
        title={element.name}
        onDelete={onDelete}
      />
      <div className="space-y-3 p-4">
        {common}
        {element.kind === "origin" && (
          <Field label="获得方式">
            <CustomSelect
              value={element.availability}
              options={[
                ["innate", "先天"],
                ["learned", "习得"],
                ["granted", "授予"],
                ["environmental", "环境"],
                ["manufactured", "制造"],
                ["institutional", "制度"],
                ["unknown", "未知"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(availability) =>
                onChange({
                  ...element,
                  availability: availability as PowerOrigin["availability"],
                })
              }
              size="toolbar"
            />
          </Field>
        )}
        {element.kind === "resource" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="计量方式">
                <CustomSelect
                  value={element.measurement}
                  options={[
                    { value: "numeric", label: "数值" },
                    { value: "ordinal", label: "等级" },
                    { value: "descriptive", label: "描述" },
                    { value: "unknown", label: "未知" },
                  ]}
                  onChange={(measurement) =>
                    onChange({
                      ...element,
                      measurement: measurement as PowerResource["measurement"],
                    })
                  }
                  size="toolbar"
                />
              </Field>
              <Field label="单位">
                <input
                  className={inputClass}
                  value={element.unit}
                  onChange={(event) =>
                    onChange({ ...element, unit: event.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="恢复方式">
              <textarea
                className={textareaClass}
                value={element.recovery}
                onChange={(event) =>
                  onChange({ ...element, recovery: event.target.value })
                }
              />
            </Field>
            <Field label="耗尽后果">
              <textarea
                className={textareaClass}
                value={element.depletion}
                onChange={(event) =>
                  onChange({ ...element, depletion: event.target.value })
                }
              />
            </Field>
          </>
        )}
        {element.kind === "method" && (
          <>
            <Field label="获得方式">
              <CustomSelect
                value={element.acquisition}
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
                    ...element,
                    acquisition: acquisition as PowerMethod["acquisition"],
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="执行过程">
              <textarea
                className={textareaClass}
                value={element.procedure}
                onChange={(event) =>
                  onChange({ ...element, procedure: event.target.value })
                }
              />
            </Field>
          </>
        )}
        {element.kind === "capability" && (
          <>
            <Field label="激活方式">
              <CustomSelect
                value={element.activation}
                options={[
                  ["active", "主动"],
                  ["passive", "被动"],
                  ["conditional", "条件触发"],
                  ["toggle", "切换"],
                  ["ritual", "仪式"],
                  ["collective", "集体"],
                  ["automatic", "自动"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(activation) =>
                  onChange({
                    ...element,
                    activation: activation as PowerCapability["activation"],
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="效果">
              <textarea
                className={textareaClass}
                value={element.effect}
                onChange={(event) =>
                  onChange({ ...element, effect: event.target.value })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="目标">
                <input
                  className={inputClass}
                  value={element.target}
                  onChange={(event) =>
                    onChange({ ...element, target: event.target.value })
                  }
                />
              </Field>
              <Field label="范围">
                <input
                  className={inputClass}
                  value={element.range}
                  onChange={(event) =>
                    onChange({ ...element, range: event.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="持续时间">
              <input
                className={inputClass}
                value={element.duration}
                onChange={(event) =>
                  onChange({ ...element, duration: event.target.value })
                }
              />
            </Field>
          </>
        )}
        <MetadataFields
          value={element.metadata}
          onChange={(metadata) => onChange({ ...element, metadata })}
        />
      </div>
    </>
  );
}

function RuleInspector({
  rule,
  onChange,
  onDelete,
}: {
  readonly rule: PowerRule;
  readonly onChange: (rule: PowerRule) => void;
  readonly onDelete: () => void;
}) {
  const updateClause = (id: string, patch: Partial<PowerConditionClause>) =>
    onChange({
      ...rule,
      conditions: {
        ...rule.conditions,
        clauses: rule.conditions.clauses.map((clause) =>
          clause.id === id ? { ...clause, ...patch } : clause,
        ),
      },
    });
  return (
    <>
      <InspectorHeader eyebrow="规则" title={rule.name} onDelete={onDelete} />
      <div className="space-y-3 p-4">
        <Field label="名称">
          <input
            className={inputClass}
            value={rule.name}
            onChange={(event) =>
              onChange({ ...rule, name: event.target.value })
            }
          />
        </Field>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Field label="条件组合">
            <CustomSelect
              value={rule.conditions.mode}
              options={[
                { value: "all", label: "满足全部" },
                { value: "any", label: "满足任一" },
              ]}
              onChange={(mode) =>
                onChange({
                  ...rule,
                  conditions: {
                    ...rule.conditions,
                    mode: mode as PowerRule["conditions"]["mode"],
                  },
                })
              }
              size="toolbar"
            />
          </Field>
          <Field label="优先级">
            <input
              type="number"
              min={0}
              max={9999}
              className={inputClass}
              value={rule.priority}
              onChange={(event) =>
                onChange({ ...rule, priority: Number(event.target.value) })
              }
            />
          </Field>
        </div>
        <div className="space-y-2">
          {rule.conditions.clauses.map((clause) => (
            <div
              key={clause.id}
              className="grid grid-cols-[1fr_7rem_1fr_2rem] gap-1.5"
            >
              <input
                className={inputClass}
                value={clause.subject}
                placeholder="对象或事实"
                onChange={(event) =>
                  updateClause(clause.id, { subject: event.target.value })
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
                  ["exists", "存在"],
                  ["not-exists", "不存在"],
                  ["matches", "符合"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(operator) =>
                  updateClause(clause.id, {
                    operator: operator as PowerConditionClause["operator"],
                  })
                }
                size="toolbar"
              />
              <input
                className={inputClass}
                value={clause.value}
                placeholder="值"
                onChange={(event) =>
                  updateClause(clause.id, { value: event.target.value })
                }
              />
              <button
                type="button"
                title="删除条件"
                onClick={() =>
                  onChange({
                    ...rule,
                    conditions: {
                      ...rule.conditions,
                      clauses: rule.conditions.clauses.filter(
                        (item) => item.id !== clause.id,
                      ),
                    },
                  })
                }
                className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...rule,
                conditions: {
                  ...rule.conditions,
                  clauses: [
                    ...rule.conditions.clauses,
                    {
                      id: createId("clause"),
                      subject: "新条件",
                      operator: "equals",
                      value: "",
                    },
                  ],
                },
              })
            }
            className="flex h-8 items-center gap-1 text-xs font-medium text-[var(--accent-warm)]"
          >
            <Plus className="h-3.5 w-3.5" /> 添加条件
          </button>
        </div>
        <Field label="成立结果（每行一项）">
          <textarea
            className={textareaClass}
            value={rule.effects.join("\n")}
            onChange={(event) =>
              onChange({ ...rule, effects: lines(event.target.value) })
            }
          />
        </Field>
        <Field label="代价（每行一项）">
          <textarea
            className={textareaClass}
            value={rule.costs.join("\n")}
            onChange={(event) =>
              onChange({ ...rule, costs: lines(event.target.value) })
            }
          />
        </Field>
        <Field label="例外（每行一项）">
          <textarea
            className={textareaClass}
            value={rule.exceptions.join("\n")}
            onChange={(event) =>
              onChange({ ...rule, exceptions: lines(event.target.value) })
            }
          />
        </Field>
        <Field label="摘要">
          <textarea
            className={textareaClass}
            value={rule.summary}
            onChange={(event) =>
              onChange({ ...rule, summary: event.target.value })
            }
          />
        </Field>
        <MetadataFields
          value={rule.metadata}
          onChange={(metadata) => onChange({ ...rule, metadata })}
        />
      </div>
    </>
  );
}

export default function PowerSystemInspector({
  selection,
  record,
  meta,
  index,
  interactions,
  onChange,
  onInteractionsChange,
  onSelectionChange,
}: PowerSystemInspectorProps) {
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
                onChange({ ...record, name: event.target.value })
              }
            />
          </Field>
          <Field label="别名（逗号分隔）">
            <input
              className={inputClass}
              value={record.aliases.join("，")}
              onChange={(event) =>
                onChange({
                  ...record,
                  aliases: event.target.value
                    .split(/[，,]/u)
                    .map((item) => item.trim())
                    .filter(Boolean),
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
                onChange={(typeId) => onChange({ ...record, typeId })}
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
                  onChange({
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
                onChange({ ...record, summary: event.target.value })
              }
            />
          </Field>
          <div className="border-t border-[var(--line-subtle)] pt-3">
            <h3 className="mb-3 text-xs font-semibold text-[var(--ink-muted)]">
              设计契约
            </h3>
            <div className="space-y-3">
              <Field label="解释程度">
                <CustomSelect
                  value={record.designContract.explanation}
                  options={[
                    { value: "explicit", label: "明确解释" },
                    { value: "partial", label: "部分解释" },
                    { value: "mysterious", label: "刻意神秘" },
                  ]}
                  onChange={(explanation) =>
                    onChange({
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
                    { value: "none", label: "无成长轨道" },
                    { value: "single-track", label: "单轨" },
                    { value: "multi-track", label: "多轨" },
                    { value: "event-driven", label: "事件驱动" },
                  ]}
                  onChange={(progression) =>
                    onChange({
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
              <Field label="代价要求">
                <CustomSelect
                  value={record.designContract.costPolicy}
                  options={[
                    { value: "required", label: "必须有代价" },
                    { value: "recommended", label: "建议有代价" },
                    { value: "optional", label: "代价可选" },
                  ]}
                  onChange={(costPolicy) =>
                    onChange({
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
            </div>
          </div>
          <MetadataFields
            value={record.metadata}
            onChange={(metadata) => onChange({ ...record, metadata })}
          />
        </div>
      </>
    );
  }

  if (selection.kind === "element") {
    const element = record.elements.find((item) => item.id === selection.id);
    if (!element) return null;
    return (
      <ElementInspector
        element={element}
        onChange={(next) =>
          onChange({
            ...record,
            elements: record.elements.map((item) =>
              item.id === next.id ? next : item,
            ),
          })
        }
        onDelete={() => {
          onChange({
            ...record,
            elements: record.elements.filter((item) => item.id !== element.id),
            relations: record.relations.filter(
              (relation) =>
                relation.fromId !== element.id && relation.toId !== element.id,
            ),
            rules: record.rules.map((rule) => ({
              ...rule,
              scopeElementIds: rule.scopeElementIds.filter(
                (id) => id !== element.id,
              ),
            })),
          });
          onSelectionChange({ kind: "system" });
        }}
      />
    );
  }

  if (selection.kind === "relation") {
    const relation = record.relations.find((item) => item.id === selection.id);
    if (!relation) return null;
    const update = (next: PowerRelation) =>
      onChange({
        ...record,
        relations: record.relations.map((item) =>
          item.id === next.id ? next : item,
        ),
      });
    return (
      <>
        <InspectorHeader
          eyebrow="因果关系"
          title={`${relation.fromId} → ${relation.toId}`}
          onDelete={() => {
            onChange({
              ...record,
              relations: record.relations.filter(
                (item) => item.id !== relation.id,
              ),
            });
            onSelectionChange({ kind: "system" });
          }}
        />
        <div className="space-y-3 p-4">
          <Field label="关系类型">
            <CustomSelect
              value={relation.kind}
              options={[
                ["produces", "产生"],
                ["stores", "储存"],
                ["converts", "转化"],
                ["consumes", "消耗"],
                ["requires", "需要"],
                ["grants", "授予"],
                ["unlocks", "解锁"],
                ["amplifies", "增强"],
                ["suppresses", "削弱"],
                ["counters", "克制"],
                ["immune-to", "免疫"],
                ["exclusive-with", "互斥"],
                ["replaces", "替代"],
                ["depends-on", "依赖"],
                ["bound-to", "绑定"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(kind) =>
                update({ ...relation, kind: kind as PowerRelation["kind"] })
              }
              size="toolbar"
            />
          </Field>
          <Field label="说明">
            <textarea
              className={textareaClass}
              value={relation.summary}
              onChange={(event) =>
                update({ ...relation, summary: event.target.value })
              }
            />
          </Field>
        </div>
      </>
    );
  }

  if (selection.kind === "track") {
    const track = record.tracks.find((item) => item.id === selection.id);
    if (!track) return null;
    const update = (next: PowerStateTrack) =>
      onChange({
        ...record,
        tracks: record.tracks.map((item) =>
          item.id === next.id ? next : item,
        ),
      });
    return (
      <>
        <InspectorHeader
          eyebrow="状态轨道"
          title={track.name}
          onDelete={() => {
            const removedIds = new Set([
              track.id,
              ...track.states.map((state) => state.id),
            ]);
            onChange({
              ...record,
              tracks: record.tracks.filter((item) => item.id !== track.id),
              relations: record.relations.filter(
                (relation) =>
                  !removedIds.has(relation.fromId) &&
                  !removedIds.has(relation.toId),
              ),
            });
            onSelectionChange({ kind: "system" });
          }}
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
          <Field label="结构模式">
            <CustomSelect
              value={track.mode}
              options={[
                ["ordered", "有序"],
                ["branching", "分支"],
                ["coexisting", "可并存"],
                ["cyclic", "循环"],
                ["threshold", "阈值"],
                ["event-driven", "事件驱动"],
                ["unordered", "无顺序"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(mode) =>
                update({ ...track, mode: mode as PowerStateTrack["mode"] })
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
    const update = (next: PowerState) =>
      onChange({
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
      });
    return (
      <>
        <InspectorHeader
          eyebrow={`状态 · ${track.name}`}
          title={state.name}
          onDelete={() => {
            onChange({
              ...record,
              tracks: record.tracks.map((item) =>
                item.id === track.id
                  ? {
                      ...item,
                      states: item.states.filter(
                        (candidate) => candidate.id !== state.id,
                      ),
                      transitions: item.transitions.filter(
                        (transition) =>
                          transition.fromStateId !== state.id &&
                          transition.toStateId !== state.id,
                      ),
                    }
                  : item,
              ),
              relations: record.relations.filter(
                (relation) =>
                  relation.fromId !== state.id && relation.toId !== state.id,
              ),
            });
            onSelectionChange({ kind: "track", id: track.id });
          }}
        />
        <div className="space-y-3 p-4">
          <Field label="状态名称">
            <input
              className={inputClass}
              value={state.name}
              onChange={(event) =>
                update({ ...state, name: event.target.value })
              }
            />
          </Field>
          <Field label="说明">
            <textarea
              className={textareaClass}
              value={state.summary}
              onChange={(event) =>
                update({ ...state, summary: event.target.value })
              }
            />
          </Field>
          <MetadataFields
            value={state.metadata}
            onChange={(metadata) => update({ ...state, metadata })}
          />
        </div>
      </>
    );
  }

  if (selection.kind === "transition") {
    const track = record.tracks.find((item) => item.id === selection.trackId);
    const transition = track?.transitions.find(
      (item) => item.id === selection.id,
    );
    if (!track || !transition) return null;
    const update = (next: typeof transition) =>
      onChange({
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
    const updateClause = (id: string, patch: Partial<PowerConditionClause>) =>
      update({
        ...transition,
        conditions: {
          ...transition.conditions,
          clauses: transition.conditions.clauses.map((clause) =>
            clause.id === id ? { ...clause, ...patch } : clause,
          ),
        },
      });
    return (
      <>
        <InspectorHeader
          eyebrow={`状态转换 · ${track.name}`}
          title={`${track.states.find((state) => state.id === transition.fromStateId)?.name ?? "入口"} → ${track.states.find((state) => state.id === transition.toStateId)?.name ?? "未知"}`}
          onDelete={() => {
            onChange({
              ...record,
              tracks: record.tracks.map((item) =>
                item.id === track.id
                  ? {
                      ...item,
                      transitions: item.transitions.filter(
                        (candidate) => candidate.id !== transition.id,
                      ),
                    }
                  : item,
              ),
            });
            onSelectionChange({ kind: "track", id: track.id });
          }}
        />
        <div className="space-y-3 p-4">
          <Field label="转换类型">
            <CustomSelect
              value={transition.kind}
              options={[
                ["advance", "推进"],
                ["branch", "分支"],
                ["merge", "合流"],
                ["regress", "回退"],
                ["transform", "变形"],
                ["recover", "恢复"],
                ["event", "事件触发"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(kind) =>
                update({
                  ...transition,
                  kind: kind as typeof transition.kind,
                })
              }
              size="toolbar"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="起点">
              <CustomSelect
                value={transition.fromStateId ?? ""}
                options={[
                  { value: "", label: "体系入口" },
                  ...track.states.map((state) => ({
                    value: state.id,
                    label: state.name,
                  })),
                ]}
                onChange={(fromStateId) =>
                  update({
                    ...transition,
                    fromStateId: fromStateId || null,
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
          <Field label="条件组合">
            <CustomSelect
              value={transition.conditions.mode}
              options={[
                { value: "all", label: "满足全部" },
                { value: "any", label: "满足任一" },
              ]}
              onChange={(mode) =>
                update({
                  ...transition,
                  conditions: {
                    ...transition.conditions,
                    mode: mode as typeof transition.conditions.mode,
                  },
                })
              }
              size="toolbar"
            />
          </Field>
          <div className="space-y-2">
            {transition.conditions.clauses.map((clause) => (
              <div
                key={clause.id}
                className="grid grid-cols-[1fr_6.5rem_1fr_2rem] gap-1.5"
              >
                <input
                  className={inputClass}
                  value={clause.subject}
                  placeholder="对象或事实"
                  onChange={(event) =>
                    updateClause(clause.id, { subject: event.target.value })
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
                    ["exists", "存在"],
                    ["not-exists", "不存在"],
                    ["matches", "符合"],
                  ].map(([value, label]) => ({ value, label }))}
                  onChange={(operator) =>
                    updateClause(clause.id, {
                      operator: operator as PowerConditionClause["operator"],
                    })
                  }
                  size="toolbar"
                />
                <input
                  className={inputClass}
                  value={clause.value}
                  placeholder="值"
                  onChange={(event) =>
                    updateClause(clause.id, { value: event.target.value })
                  }
                />
                <button
                  type="button"
                  title="删除条件"
                  onClick={() =>
                    update({
                      ...transition,
                      conditions: {
                        ...transition.conditions,
                        clauses: transition.conditions.clauses.filter(
                          (item) => item.id !== clause.id,
                        ),
                      },
                    })
                  }
                  className="flex h-9 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                update({
                  ...transition,
                  conditions: {
                    ...transition.conditions,
                    clauses: [
                      ...transition.conditions.clauses,
                      {
                        id: createId("clause"),
                        subject: "新条件",
                        operator: "equals",
                        value: "",
                      },
                    ],
                  },
                })
              }
              className="flex h-8 items-center gap-1 text-xs font-medium text-[var(--accent-warm)]"
            >
              <Plus className="h-3.5 w-3.5" /> 添加条件
            </button>
          </div>
          <Field label="成本（每行一项）">
            <textarea
              className={textareaClass}
              value={transition.costs.join("\n")}
              onChange={(event) =>
                update({ ...transition, costs: lines(event.target.value) })
              }
            />
          </Field>
          <Field label="结果（每行一项）">
            <textarea
              className={textareaClass}
              value={transition.outcomes.join("\n")}
              onChange={(event) =>
                update({ ...transition, outcomes: lines(event.target.value) })
              }
            />
          </Field>
          <Field label="失败后果">
            <textarea
              className={textareaClass}
              value={transition.failure}
              onChange={(event) =>
                update({ ...transition, failure: event.target.value })
              }
            />
          </Field>
        </div>
      </>
    );
  }

  if (selection.kind === "rule") {
    const rule = record.rules.find((item) => item.id === selection.id);
    if (!rule) return null;
    return (
      <RuleInspector
        rule={rule}
        onChange={(next) =>
          onChange({
            ...record,
            rules: record.rules.map((item) =>
              item.id === next.id ? next : item,
            ),
          })
        }
        onDelete={() => {
          onChange({
            ...record,
            rules: record.rules.filter((item) => item.id !== rule.id),
          });
          onSelectionChange({ kind: "system" });
        }}
      />
    );
  }

  if (selection.kind === "dimension") {
    const dimension = record.dimensions.find(
      (item) => item.id === selection.id,
    );
    if (!dimension) return null;
    const update = (next: PowerDimension) =>
      onChange({
        ...record,
        dimensions: record.dimensions.map((item) =>
          item.id === next.id ? next : item,
        ),
      });
    return (
      <>
        <InspectorHeader
          eyebrow="比较维度"
          title={dimension.name}
          onDelete={() => {
            onChange({
              ...record,
              dimensions: record.dimensions.filter(
                (item) => item.id !== dimension.id,
              ),
              benchmarks: record.benchmarks.map((benchmark) => ({
                ...benchmark,
                values: benchmark.values.filter(
                  (value) => value.dimensionId !== dimension.id,
                ),
              })),
            });
            onSelectionChange({ kind: "system" });
          }}
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
                  measurement: measurement as PowerDimension["measurement"],
                })
              }
              size="toolbar"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="低端标签">
              <input
                className={inputClass}
                value={dimension.lowLabel}
                onChange={(event) =>
                  update({ ...dimension, lowLabel: event.target.value })
                }
              />
            </Field>
            <Field label="高端标签">
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

  if (selection.kind === "benchmark") {
    const benchmark = record.benchmarks.find(
      (item) => item.id === selection.id,
    );
    if (!benchmark) return null;
    const update = (next: PowerBenchmark) =>
      onChange({
        ...record,
        benchmarks: record.benchmarks.map((item) =>
          item.id === next.id ? next : item,
        ),
      });
    return (
      <>
        <InspectorHeader
          eyebrow="场景标尺"
          title={benchmark.name}
          onDelete={() => {
            onChange({
              ...record,
              benchmarks: record.benchmarks.filter(
                (item) => item.id !== benchmark.id,
              ),
            });
            onSelectionChange({ kind: "system" });
          }}
        />
        <div className="space-y-3 p-4">
          <Field label="名称">
            <input
              className={inputClass}
              value={benchmark.name}
              onChange={(event) =>
                update({ ...benchmark, name: event.target.value })
              }
            />
          </Field>
          <Field label="场景条件">
            <textarea
              className={textareaClass}
              value={benchmark.context}
              onChange={(event) =>
                update({ ...benchmark, context: event.target.value })
              }
            />
          </Field>
          {record.dimensions.map((dimension) => {
            const value = benchmark.values.find(
              (candidate) => candidate.dimensionId === dimension.id,
            ) ?? {
              dimensionId: dimension.id,
              minimum: null,
              maximum: null,
              label: "",
            };
            const changeValue = (patch: Partial<typeof value>) =>
              update({
                ...benchmark,
                values: [
                  ...benchmark.values.filter(
                    (candidate) => candidate.dimensionId !== dimension.id,
                  ),
                  { ...value, ...patch },
                ],
              });
            return (
              <div
                key={dimension.id}
                className="border-t border-[var(--line-subtle)] pt-3"
              >
                <div className="mb-2 text-xs font-medium text-[var(--ink)]">
                  {dimension.name}
                </div>
                {dimension.measurement === "numeric" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="下限">
                      <input
                        type="number"
                        className={inputClass}
                        value={value.minimum ?? ""}
                        onChange={(event) =>
                          changeValue({
                            minimum:
                              event.target.value === ""
                                ? null
                                : Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field label="上限">
                      <input
                        type="number"
                        className={inputClass}
                        value={value.maximum ?? ""}
                        onChange={(event) =>
                          changeValue({
                            maximum:
                              event.target.value === ""
                                ? null
                                : Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                  </div>
                ) : (
                  <Field label="描述">
                    <input
                      className={inputClass}
                      value={value.label}
                      onChange={(event) =>
                        changeValue({ label: event.target.value })
                      }
                    />
                  </Field>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  const interaction = interactions.interactions.find(
    (item) => selection.kind === "interaction" && item.id === selection.id,
  );
  if (!interaction) return null;
  const updateInteraction = (next: CrossSystemInteraction) =>
    onInteractionsChange({
      ...interactions,
      interactions: interactions.interactions.map((item) =>
        item.id === next.id ? next : item,
      ),
    });
  return (
    <>
      <InspectorHeader
        eyebrow="跨体系交互"
        title={interaction.name}
        onDelete={() => {
          onInteractionsChange({
            ...interactions,
            interactions: interactions.interactions.filter(
              (item) => item.id !== interaction.id,
            ),
          });
          onSelectionChange({ kind: "system" });
        }}
      />
      <div className="space-y-3 p-4">
        <Field label="名称">
          <input
            className={inputClass}
            value={interaction.name}
            onChange={(event) =>
              updateInteraction({ ...interaction, name: event.target.value })
            }
          />
        </Field>
        <Field label="交互类型">
          <CustomSelect
            value={interaction.kind}
            options={[
              ["amplifies", "增强"],
              ["suppresses", "压制"],
              ["counters", "克制"],
              ["immune-to", "免疫"],
              ["converts", "转化"],
              ["compatible", "兼容"],
              ["exclusive", "互斥"],
              ["incomparable", "不可比较"],
            ].map(([value, label]) => ({ value, label }))}
            onChange={(kind) =>
              updateInteraction({
                ...interaction,
                kind: kind as CrossSystemInteraction["kind"],
              })
            }
            size="toolbar"
          />
        </Field>
        {(["left", "right"] as const).map((side) => (
          <div
            key={side}
            className="space-y-2 border-t border-[var(--line-subtle)] pt-3"
          >
            <div className="text-xs font-semibold text-[var(--ink-muted)]">
              {side === "left" ? "左侧对象" : "右侧对象"}
            </div>
            <Field label="体系">
              <CustomSelect
                value={interaction[side].systemId}
                options={index.systems.map((system) => ({
                  value: system.id,
                  label: system.name,
                }))}
                onChange={(systemId) =>
                  updateInteraction({
                    ...interaction,
                    [side]: { ...interaction[side], systemId },
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="对象类型">
              <CustomSelect
                value={interaction[side].kind}
                options={[
                  ["system", "完整体系"],
                  ["origin", "来源"],
                  ["resource", "资源"],
                  ["method", "方式"],
                  ["capability", "能力"],
                  ["track", "轨道"],
                  ["state", "状态"],
                  ["rule", "规则"],
                  ["dimension", "维度"],
                ].map(([value, label]) => ({ value, label }))}
                onChange={(kind) =>
                  updateInteraction({
                    ...interaction,
                    [side]: {
                      ...interaction[side],
                      kind: kind as CrossSystemInteraction[typeof side]["kind"],
                    },
                  })
                }
                size="toolbar"
              />
            </Field>
            <Field label="稳定 ID">
              <input
                className={inputClass}
                value={interaction[side].targetId}
                onChange={(event) =>
                  updateInteraction({
                    ...interaction,
                    [side]: {
                      ...interaction[side],
                      targetId: event.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>
        ))}
        <Field label="说明">
          <textarea
            className={textareaClass}
            value={interaction.summary}
            onChange={(event) =>
              updateInteraction({ ...interaction, summary: event.target.value })
            }
          />
        </Field>
      </div>
    </>
  );
}

export function createPowerRule(): PowerRule {
  return {
    id: createId("rule"),
    name: "新规则",
    summary: "",
    priority: 100,
    conditions: { mode: "all", clauses: [] },
    effects: [],
    costs: [],
    exceptions: [],
    scopeElementIds: [],
    metadata: createDefaultPowerTruthMetadata(),
  };
}
