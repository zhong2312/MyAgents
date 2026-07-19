import type {
  CategoryFieldDefinition,
  ItemFieldDefinition,
  ItemFieldValue,
  ItemRecord,
} from "./itemLibrarySchema";

export type ItemAiMode = "profile" | "description";

export interface ItemAiRunRequest {
  readonly sceneId: "items.profile" | "items.description";
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface ItemAiContext {
  readonly projectTitle: string;
  readonly categoryPath: string;
  readonly record: ItemRecord;
  readonly pageContent: string;
  readonly categoryFields: readonly CategoryFieldDefinition[];
}

export interface ItemProfileAiSuggestion {
  readonly kind: "profile";
  readonly summary?: string;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly values: Readonly<Record<string, ItemFieldValue>>;
}

export interface ItemDescriptionAiSuggestion {
  readonly kind: "description";
  readonly content: string;
}

export type ItemAiSuggestion =
  | ItemProfileAiSuggestion
  | ItemDescriptionAiSuggestion;

type EffectiveField = ItemFieldDefinition | CategoryFieldDefinition;

const PAGE_CONTEXT_LIMIT = 12_000;

function effectiveFields(context: ItemAiContext): readonly EffectiveField[] {
  return [
    ...context.categoryFields,
    ...context.record.itemFields.filter((field) => !field.archived),
  ];
}

function fieldPrompt(field: EffectiveField, record: ItemRecord) {
  return {
    fieldId: field.id,
    label: field.label,
    description: field.description,
    group: field.group,
    type: field.type,
    required: field.required,
    options: field.options,
    unit: field.unit ?? null,
    entityTypes: field.entityTypes ?? [],
    currentValue: record.values[field.id] ?? null,
  };
}

function compactContext(context: ItemAiContext) {
  return {
    projectTitle: context.projectTitle,
    item: {
      id: context.record.id,
      name: context.record.name,
      aliases: context.record.aliases,
      category: context.categoryPath,
      status: context.record.status,
      tags: context.record.tags,
      summary: context.record.summary,
    },
    fields: effectiveFields(context).map((field) =>
      fieldPrompt(field, context.record),
    ),
    currentDescription: context.pageContent.slice(0, PAGE_CONTEXT_LIMIT),
  };
}

export function createItemAiRunRequest(
  mode: ItemAiMode,
  context: ItemAiContext,
): ItemAiRunRequest {
  const serializedContext = JSON.stringify(compactContext(context), null, 2);
  if (mode === "description") {
    return {
      sceneId: "items.description",
      label: `AI 撰写物品描述 · ${context.record.name}`,
      systemPrompt:
        "你是严谨的中文小说设定编辑。依据已提供事实撰写完整的 Markdown 物品描述；不得改变明确事实，不得虚构与上下文冲突的角色、地点或规则。只输出 Markdown 正文，不要代码块围栏，不要解释。",
      prompt: `请为当前物品撰写或完善完整描述。保留已有有效内容，重点组织来历、外观、能力、限制、代价和剧情用途；没有依据的部分保持克制，不要用占位符。一级标题必须是物品名称。\n\n当前上下文：\n${serializedContext}`,
    };
  }
  return {
    sceneId: "items.profile",
    label: `AI 完善物品资料 · ${context.record.name}`,
    systemPrompt:
      "你是严谨的中文小说设定编辑。只补充能够从上下文合理推导、且有助于后续创作的物品资料。不得修改稳定 ID、名称、分类或状态，不得覆盖明确事实。只输出一个严格 JSON 对象，不要 Markdown 围栏或解释。",
    prompt: `请完善当前物品的空缺或薄弱资料。只返回确有改进的字段；values 只能使用上下文列出的 fieldId，并严格遵守字段类型和选项。不要用空字符串清除现有信息。\n\n返回格式：\n{"summary":"可选摘要","aliases":["可选别名"],"tags":["可选标签"],"values":{"field-id":"与字段类型匹配的值"}}\n\n当前上下文：\n${serializedContext}`,
  };
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json|markdown|md)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function normalizedTerms(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const terms = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return terms.length ? terms : undefined;
}

function normalizeFieldValue(
  field: EffectiveField,
  value: unknown,
): ItemFieldValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`AI 返回的“${field.label}”不是有效数字`);
    }
    return value;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`AI 返回的“${field.label}”不是开关值`);
    }
    return value;
  }
  if (field.type === "multi-select") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`AI 返回的“${field.label}”不是有效多选值`);
    }
    const values = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
    const invalid = values.find(
      (item) => field.options.length > 0 && !field.options.includes(item),
    );
    if (invalid) throw new Error(`AI 为“${field.label}”返回了非法选项：${invalid}`);
    return values.length ? values : undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`AI 返回的“${field.label}”不是文本值`);
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (
    field.type === "single-select" &&
    field.options.length > 0 &&
    !field.options.includes(normalized)
  ) {
    throw new Error(`AI 为“${field.label}”返回了非法选项：${normalized}`);
  }
  return normalized;
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseItemAiOutput(
  mode: ItemAiMode,
  output: string,
  context: ItemAiContext,
): ItemAiSuggestion {
  if (mode === "description") {
    const content = stripCodeFence(output);
    if (!content) throw new Error("AI 没有返回可用的物品描述");
    if (content === context.pageContent.trim()) {
      throw new Error("AI 返回的描述没有产生变化");
    }
    return { kind: "description", content };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(output));
  } catch (error) {
    throw new Error(
      `AI 资料结果不是有效 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI 资料结果必须是 JSON 对象");
  }
  const candidate = parsed as Record<string, unknown>;
  const summaryCandidate =
    typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  const summary =
    summaryCandidate && summaryCandidate !== context.record.summary
      ? summaryCandidate
      : undefined;
  const rawAliasesCandidate = normalizedTerms(candidate.aliases);
  const aliasesCandidate = rawAliasesCandidate
    ? [...new Set([...context.record.aliases, ...rawAliasesCandidate])]
    : undefined;
  const aliases =
    aliasesCandidate && !equalValue(aliasesCandidate, context.record.aliases)
      ? aliasesCandidate
      : undefined;
  const rawTagsCandidate = normalizedTerms(candidate.tags);
  const tagsCandidate = rawTagsCandidate
    ? [...new Set([...context.record.tags, ...rawTagsCandidate])]
    : undefined;
  const tags =
    tagsCandidate && !equalValue(tagsCandidate, context.record.tags)
      ? tagsCandidate
      : undefined;

  const fieldsById = new Map(
    effectiveFields(context).map((field) => [field.id, field]),
  );
  const values: Record<string, ItemFieldValue> = {};
  if (candidate.values !== undefined) {
    if (
      !candidate.values ||
      typeof candidate.values !== "object" ||
      Array.isArray(candidate.values)
    ) {
      throw new Error("AI 资料结果的 values 必须是对象");
    }
    for (const [fieldId, rawValue] of Object.entries(candidate.values)) {
      const field = fieldsById.get(fieldId);
      if (!field) throw new Error(`AI 返回了当前物品不允许的字段：${fieldId}`);
      const value = normalizeFieldValue(field, rawValue);
      if (
        value !== undefined &&
        !equalValue(value, context.record.values[fieldId])
      ) {
        values[fieldId] = value;
      }
    }
  }

  if (!summary && !aliases && !tags && Object.keys(values).length === 0) {
    throw new Error("AI 没有返回可应用的资料建议");
  }
  return { kind: "profile", summary, aliases, tags, values };
}
