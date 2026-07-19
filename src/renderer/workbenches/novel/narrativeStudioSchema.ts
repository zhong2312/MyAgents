import { z } from "zod";

export const NARRATIVE_STUDIO_SCHEMA_VERSION = 1 as const;

export const NARRATIVE_STUDIO_PATHS = Object.freeze({
  narrative: "story/narrative-design.json",
  inspirations: "inspiration/index.json",
  profile: "settings/creative-profile.json",
});

const idSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, "id 只能包含小写字母、数字、点、下划线和连字符");
const textSchema = z.string();
const nonEmptyTextSchema = z.string().trim().min(1);
const dateTimeSchema = z.string().datetime();
const uniqueIds = (values: readonly string[], path: (string | number)[], context: z.RefinementCtx) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "id 不得重复",
      });
    }
    seen.add(value);
  });
};

export const narrativeObjectKindSchema = z.enum([
  "structure",
  "thread",
  "arc",
  "node",
  "expectation",
  "chapter-plan",
]);
export type NarrativeObjectKind = z.infer<typeof narrativeObjectKindSchema>;

export const narrativePlanStatusSchema = z.enum([
  "planned",
  "active",
  "complete",
  "paused",
  "abandoned",
]);
export type NarrativePlanStatus = z.infer<typeof narrativePlanStatusSchema>;

export const narrativeCheckStatusSchema = z.enum([
  "pending",
  "passed",
  "waived",
]);
export type NarrativeCheckStatus = z.infer<typeof narrativeCheckStatusSchema>;

export const narrativeChecklistItemSchema = z
  .object({
    id: idSchema,
    label: nonEmptyTextSchema,
    sourceDefinitionId: idSchema.nullable(),
    status: narrativeCheckStatusSchema,
    waiverReason: textSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === "waived" && !item.waiverReason.trim()) {
      context.addIssue({
        code: "custom",
        path: ["waiverReason"],
        message: "手工豁免必须填写原因",
      });
    }
  });
export type NarrativeChecklistItem = z.infer<
  typeof narrativeChecklistItemSchema
>;

export const narrativeStructureSchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable(),
    typeId: idSchema,
    title: nonEmptyTextSchema,
    summary: textSchema,
    order: z.number().int().nonnegative(),
    status: narrativePlanStatusSchema,
    acceptanceCriteria: z.array(narrativeChecklistItemSchema),
  })
  .strict();
export type NarrativeStructure = z.infer<typeof narrativeStructureSchema>;

export const narrativeThreadSchema = z
  .object({
    id: idSchema,
    typeId: idSchema,
    title: nonEmptyTextSchema,
    summary: textSchema,
    color: z.string().trim().min(1),
    order: z.number().int().nonnegative(),
    status: narrativePlanStatusSchema,
    checklist: z.array(narrativeChecklistItemSchema).default([]),
  })
  .strict();
export type NarrativeThread = z.infer<typeof narrativeThreadSchema>;

export const narrativeArcStageSchema = z
  .object({
    id: idSchema,
    label: nonEmptyTextSchema,
    state: textSchema,
    structureId: idSchema.nullable(),
    chapterId: textSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();
export type NarrativeArcStage = z.infer<typeof narrativeArcStageSchema>;

export const narrativeArcSchema = z
  .object({
    id: idSchema,
    title: nonEmptyTextSchema,
    summary: textSchema,
    status: narrativePlanStatusSchema,
    threadIds: z.array(idSchema),
    characterIds: z.array(idSchema),
    stages: z.array(narrativeArcStageSchema),
    checklist: z.array(narrativeChecklistItemSchema).default([]),
  })
  .strict();
export type NarrativeArc = z.infer<typeof narrativeArcSchema>;

export const narrativeSituationSchema = z
  .object({
    condition: textSchema,
    action: textSchema,
    cost: textSchema,
    result: textSchema,
  })
  .strict();
export type NarrativeSituation = z.infer<typeof narrativeSituationSchema>;

export const narrativeNodeSchema = z
  .object({
    id: idSchema,
    typeId: idSchema,
    title: nonEmptyTextSchema,
    summary: textSchema,
    status: narrativePlanStatusSchema,
    structureId: idSchema.nullable(),
    chapterId: textSchema,
    sequence: z.number().int().nonnegative(),
    threadIds: z.array(idSchema),
    arcIds: z.array(idSchema),
    emotionTarget: textSchema,
    resultDimension: textSchema,
    commercialBeat: textSchema,
    situation: narrativeSituationSchema,
    checklist: z.array(narrativeChecklistItemSchema),
  })
  .strict();
export type NarrativeNode = z.infer<typeof narrativeNodeSchema>;

export const expectationMilestoneKindSchema = z.enum([
  "establish",
  "reinforce",
  "fulfill",
  "invalidate",
]);
export type ExpectationMilestoneKind = z.infer<
  typeof expectationMilestoneKindSchema
>;

export const expectationMilestoneSchema = z
  .object({
    id: idSchema,
    kind: expectationMilestoneKindSchema,
    chapterId: textSchema,
    label: nonEmptyTextSchema,
    ownership: z.enum(["planned", "actual"]),
    order: z.number().int().nonnegative(),
  })
  .strict();
export type ExpectationMilestone = z.infer<
  typeof expectationMilestoneSchema
>;

export const narrativeExpectationSchema = z
  .object({
    id: idSchema,
    typeId: idSchema,
    title: nonEmptyTextSchema,
    summary: textSchema,
    status: z.enum(["open", "fulfilled", "abandoned"]),
    threadIds: z.array(idSchema),
    milestones: z.array(expectationMilestoneSchema),
    checklist: z.array(narrativeChecklistItemSchema).default([]),
  })
  .strict();
export type NarrativeExpectation = z.infer<
  typeof narrativeExpectationSchema
>;

export const chapterPlanSchema = z
  .object({
    id: idSchema,
    chapterId: textSchema,
    chapterNumber: z.number().int().positive(),
    title: nonEmptyTextSchema,
    status: narrativePlanStatusSchema,
    objective: textSchema,
    summary: textSchema,
    beats: z.array(nonEmptyTextSchema),
    threadIds: z.array(idSchema),
    arcIds: z.array(idSchema),
    expectationIds: z.array(idSchema),
    deliveryValues: z.record(idSchema, textSchema),
    checklist: z.array(narrativeChecklistItemSchema),
  })
  .strict();
export type ChapterPlan = z.infer<typeof chapterPlanSchema>;

export const narrativeRelationSchema = z
  .object({
    id: idSchema,
    typeId: idSchema,
    fromKind: narrativeObjectKindSchema,
    fromId: idSchema,
    toKind: narrativeObjectKindSchema,
    toId: idSchema,
    ownership: z.enum(["planned", "actual"]),
    note: textSchema,
  })
  .strict();
export type NarrativeRelation = z.infer<typeof narrativeRelationSchema>;

export const narrativeDesignSchema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_STUDIO_SCHEMA_VERSION),
    structures: z.array(narrativeStructureSchema),
    threads: z.array(narrativeThreadSchema),
    arcs: z.array(narrativeArcSchema),
    nodes: z.array(narrativeNodeSchema),
    expectations: z.array(narrativeExpectationSchema),
    chapterPlans: z.array(chapterPlanSchema),
    relations: z.array(narrativeRelationSchema),
    updatedAt: dateTimeSchema,
  })
  .strict()
  .superRefine((library, context) => {
    uniqueIds(library.structures.map((item) => item.id), ["structures"], context);
    uniqueIds(library.threads.map((item) => item.id), ["threads"], context);
    uniqueIds(library.arcs.map((item) => item.id), ["arcs"], context);
    uniqueIds(library.nodes.map((item) => item.id), ["nodes"], context);
    uniqueIds(library.expectations.map((item) => item.id), ["expectations"], context);
    uniqueIds(library.chapterPlans.map((item) => item.id), ["chapterPlans"], context);
    uniqueIds(library.relations.map((item) => item.id), ["relations"], context);
  });
export type NarrativeDesign = z.infer<typeof narrativeDesignSchema>;

export const inspirationSourceSchema = z
  .object({
    kind: z.enum(["manual", "myagents-thought", "research", "web", "other"]),
    label: nonEmptyTextSchema,
    uri: textSchema,
  })
  .strict();
export type InspirationSource = z.infer<typeof inspirationSourceSchema>;

export const inspirationItemSchema = z
  .object({
    id: idSchema,
    title: nonEmptyTextSchema,
    body: textSchema,
    typeId: idSchema,
    state: z.enum(["inbox", "organizing", "unused", "archived"]),
    source: inspirationSourceSchema,
    tags: z.array(nonEmptyTextSchema),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  })
  .strict();
export type InspirationItem = z.infer<typeof inspirationItemSchema>;

export const inspirationAdoptionSchema = z
  .object({
    id: idSchema,
    inspirationId: idSchema,
    targetKind: narrativeObjectKindSchema,
    targetId: idSchema,
    targetLabel: nonEmptyTextSchema,
    adoptedTypeId: idSchema,
    adoptedTypeLabel: nonEmptyTextSchema,
    note: textSchema,
    createdAt: dateTimeSchema,
  })
  .strict();
export type InspirationAdoption = z.infer<
  typeof inspirationAdoptionSchema
>;

export const inspirationLibrarySchema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_STUDIO_SCHEMA_VERSION),
    items: z.array(inspirationItemSchema),
    adoptions: z.array(inspirationAdoptionSchema),
    updatedAt: dateTimeSchema,
  })
  .strict()
  .superRefine((library, context) => {
    uniqueIds(library.items.map((item) => item.id), ["items"], context);
    uniqueIds(library.adoptions.map((item) => item.id), ["adoptions"], context);
    const itemIds = new Set(library.items.map((item) => item.id));
    library.adoptions.forEach((adoption, index) => {
      if (!itemIds.has(adoption.inspirationId)) {
        context.addIssue({
          code: "custom",
          path: ["adoptions", index, "inspirationId"],
          message: "采用记录关联的灵感不存在",
        });
      }
    });
  });
export type InspirationLibrary = z.infer<typeof inspirationLibrarySchema>;

export const creativeDefinitionCategorySchema = z.enum([
  "term",
  "object-type",
  "field",
  "relation",
  "check",
  "view",
]);
export type CreativeDefinitionCategory = z.infer<
  typeof creativeDefinitionCategorySchema
>;

export const creativeDefinitionScopeSchema = z.enum([
  "global",
  "structure",
  "thread",
  "arc",
  "node",
  "expectation",
  "chapter",
  "inspiration",
]);
export type CreativeDefinitionScope = z.infer<
  typeof creativeDefinitionScopeSchema
>;

export const creativeDefinitionSchema = z
  .object({
    id: idSchema,
    category: creativeDefinitionCategorySchema,
    name: nonEmptyTextSchema,
    description: textSchema,
    operation: z.enum(["define", "extend", "override"]),
    targetId: idSchema.nullable(),
    scope: creativeDefinitionScopeSchema,
    valueType: z
      .enum([
        "text",
        "long-text",
        "number",
        "boolean",
        "single-select",
        "multi-select",
      ])
      .nullable(),
    required: z.boolean(),
    options: z.array(nonEmptyTextSchema),
  })
  .strict();
export type CreativeDefinition = z.infer<typeof creativeDefinitionSchema>;

export const creativeLayerKindSchema = z.enum([
  "core",
  "length",
  "publication",
  "genre",
  "method",
  "project",
  "author",
]);
export type CreativeLayerKind = z.infer<typeof creativeLayerKindSchema>;

export const creativeProfileLayerSchema = z
  .object({
    id: idSchema,
    name: nonEmptyTextSchema,
    kind: creativeLayerKindSchema,
    description: textSchema,
    enabled: z.boolean(),
    locked: z.boolean(),
    order: z.number().int().nonnegative(),
    source: nonEmptyTextSchema,
    definitions: z.array(creativeDefinitionSchema),
  })
  .strict();
export type CreativeProfileLayer = z.infer<typeof creativeProfileLayerSchema>;

export const creativeProfileSchema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_STUDIO_SCHEMA_VERSION),
    layers: z.array(creativeProfileLayerSchema).min(1),
    updatedAt: dateTimeSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    uniqueIds(profile.layers.map((item) => item.id), ["layers"], context);
    const coreLayers = profile.layers.filter((layer) => layer.kind === "core");
    if (coreLayers.length !== 1 || !coreLayers[0]?.locked || !coreLayers[0].enabled) {
      context.addIssue({
        code: "custom",
        path: ["layers"],
        message: "创作方案必须且只能包含一个启用并锁定的通用内核",
      });
    }
  });
export type CreativeProfile = z.infer<typeof creativeProfileSchema>;

export interface ResolvedCreativeDefinition extends CreativeDefinition {
  readonly layerId: string;
  readonly layerName: string;
  readonly overriddenDefinitionId: string | null;
}

export interface CreativeProfileConflict {
  readonly id: string;
  readonly layerId: string;
  readonly definitionId: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface ResolvedCreativeProfile {
  readonly definitions: readonly ResolvedCreativeDefinition[];
  readonly conflicts: readonly CreativeProfileConflict[];
}

export class NarrativeStudioFormatError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} 数据格式无效：${detail}`);
    this.name = "NarrativeStudioFormatError";
  }
}

function parseJson<T>(file: string, content: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new NarrativeStudioFormatError(
      file,
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new NarrativeStudioFormatError(
      file,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

export function parseNarrativeDesign(content: string): NarrativeDesign {
  return parseJson(NARRATIVE_STUDIO_PATHS.narrative, content, narrativeDesignSchema);
}

export function parseInspirationLibrary(content: string): InspirationLibrary {
  return parseJson(
    NARRATIVE_STUDIO_PATHS.inspirations,
    content,
    inspirationLibrarySchema,
  );
}

export function parseCreativeProfile(content: string): CreativeProfile {
  return parseJson(NARRATIVE_STUDIO_PATHS.profile, content, creativeProfileSchema);
}

export function serializeNarrativeDesign(value: NarrativeDesign): string {
  return `${JSON.stringify(narrativeDesignSchema.parse(value), null, 2)}\n`;
}

export function serializeInspirationLibrary(value: InspirationLibrary): string {
  return `${JSON.stringify(inspirationLibrarySchema.parse(value), null, 2)}\n`;
}

export function serializeCreativeProfile(value: CreativeProfile): string {
  return `${JSON.stringify(creativeProfileSchema.parse(value), null, 2)}\n`;
}

export function createEmptyNarrativeDesign(createdAt: string): NarrativeDesign {
  return {
    schemaVersion: NARRATIVE_STUDIO_SCHEMA_VERSION,
    structures: [
      {
        id: "structure-root",
        parentId: null,
        typeId: "core.structure",
        title: "全书",
        summary: "",
        order: 0,
        status: "planned",
        acceptanceCriteria: [],
      },
    ],
    threads: [],
    arcs: [],
    nodes: [],
    expectations: [],
    chapterPlans: [],
    relations: [],
    updatedAt: createdAt,
  };
}

export function createEmptyInspirationLibrary(createdAt: string): InspirationLibrary {
  return {
    schemaVersion: NARRATIVE_STUDIO_SCHEMA_VERSION,
    items: [],
    adoptions: [],
    updatedAt: createdAt,
  };
}

function definition(
  id: string,
  category: CreativeDefinitionCategory,
  name: string,
  scope: CreativeDefinitionScope,
  description: string,
  valueType: CreativeDefinition["valueType"] = null,
  required = false,
): CreativeDefinition {
  return {
    id,
    category,
    name,
    description,
    operation: "define",
    targetId: null,
    scope,
    valueType,
    required,
    options: [],
  };
}

export function createDefaultCreativeProfile(
  projectTitle: string,
  genres: readonly string[],
  createdAt: string,
): CreativeProfile {
  const genreName = genres[0]?.trim() || "未指定题材";
  return {
    schemaVersion: NARRATIVE_STUDIO_SCHEMA_VERSION,
    layers: [
      {
        id: "layer-core",
        name: "通用叙事内核",
        kind: "core",
        description: "题材中立的结构、线路、故事弧、节点、期待和情境。",
        enabled: true,
        locked: true,
        order: 0,
        source: "MyAgents 内置",
        definitions: [
          definition("core.structure", "object-type", "结构单元", "structure", "可嵌套的部、卷、幕、案件或阶段。"),
          definition("core.thread", "object-type", "叙事线路", "thread", "贯穿多个结构单元的推进线路。"),
          definition("core.arc", "object-type", "故事弧", "arc", "从起始状态到终点状态的变化。"),
          definition("core.node", "object-type", "叙事节点", "node", "场景、节拍、转折或信息揭示。"),
          definition("core.expectation", "object-type", "期待", "expectation", "承诺、悬念、谜团、伏笔或预言。"),
          definition("core.situation", "object-type", "情境", "node", "由条件、行动、代价和结果组成。"),
          definition("core.chapter-plan", "object-type", "章节计划", "chapter", "连接故事设计与正文交付。"),
          definition("idea.fragment", "object-type", "灵感片段", "inspiration", "尚未进入正式叙事结构的片段、意象、问题或触发点。"),
          definition("core.emotion-target", "field", "情绪目标", "node", "节点希望读者抵达的情绪。", "text"),
          definition("core.result-dimension", "field", "结果维度", "node", "节点造成的可见状态变化。", "long-text"),
          definition("core.adopted-as", "relation", "采用为", "inspiration", "灵感到项目对象的可追溯关系。"),
          definition("core.reference-integrity", "check", "引用完整性", "global", "检查对象间稳定引用是否有效。"),
          definition("core.thread-lanes", "view", "线路泳道", "thread", "按结构和章节查看线路节点。"),
        ],
      },
      {
        id: "layer-long-form",
        name: "长篇小说",
        kind: "length",
        description: "启用多级结构与长线状态管理。",
        enabled: true,
        locked: false,
        order: 10,
        source: "MyAgents 内置配置包",
        definitions: [
          definition("long.volume", "object-type", "卷", "structure", "长篇中的一级结构单元。"),
          definition("long.chapter-group", "object-type", "章节组", "structure", "围绕阶段目标组织的一组章节。"),
          definition("long.structure-acceptance", "check", "结构验收", "structure", "检查结构单元的完成条件。"),
        ],
      },
      {
        id: "layer-serial",
        name: "连载创作",
        kind: "publication",
        description: "启用章节推进和连载留存检查。",
        enabled: true,
        locked: false,
        order: 20,
        source: "MyAgents 内置配置包",
        definitions: [
          definition("serial.commercial-beat", "field", "连载节点", "chapter", "章节的留存、追读或转化动作。", "text"),
          definition("serial.progress-density", "check", "推进密度", "chapter", "检查连续章节是否形成有效推进。"),
        ],
      },
      {
        id: "layer-genre",
        name: genreName,
        kind: "genre",
        description: "当前题材的术语、对象类型和检查项扩展。",
        enabled: true,
        locked: false,
        order: 30,
        source: "项目题材",
        definitions: [
          definition("genre.current", "term", genreName, "global", "当前小说项目声明的主要题材。"),
        ],
      },
      {
        id: "layer-project",
        name: `《${projectTitle.trim() || "未命名小说"}》项目规则`,
        kind: "project",
        description: "只属于当前小说的术语、字段、关系和验收规则。",
        enabled: true,
        locked: false,
        order: 40,
        source: "项目本地",
        definitions: [],
      },
      {
        id: "layer-author",
        name: "作者本地调整",
        kind: "author",
        description: "作者对当前项目显示名称和工作习惯的显式覆盖。",
        enabled: true,
        locked: false,
        order: 50,
        source: "作者本地",
        definitions: [],
      },
    ],
    updatedAt: createdAt,
  };
}

export function createMysteryPreviewProfile(
  profile: CreativeProfile,
): CreativeProfile {
  return {
    ...profile,
    layers: profile.layers.map((layer) => {
      if (layer.kind === "genre") {
        return {
          ...layer,
          name: "悬疑小说",
          source: "临时预览",
          definitions: [
            definition("mystery.case", "object-type", "案件", "structure", "围绕核心谜团组织的结构单元。"),
            definition("mystery.investigation-thread", "object-type", "调查线", "thread", "围绕证据和推理推进的线路。"),
            definition("mystery.clue", "object-type", "线索", "node", "可被发现、解释和验证的信息。"),
            definition("mystery.question", "term", "谜团", "expectation", "需要建立并最终解答的期待。"),
          ],
        };
      }
      if (layer.kind === "project") {
        return {
          ...layer,
          name: "悬疑项目规则",
          source: "临时预览",
          definitions: [
            definition("mystery.clue-matrix", "view", "线索矩阵", "node", "交叉查看案件、人物和线索。"),
            definition("mystery.fairness", "check", "公平性检查", "expectation", "关键答案所需信息必须先于解答出现。"),
          ],
        };
      }
      return layer;
    }),
  };
}

export function resolveCreativeProfile(
  profile: CreativeProfile,
): ResolvedCreativeProfile {
  const resolved = new Map<string, ResolvedCreativeDefinition>();
  const conflicts: CreativeProfileConflict[] = [];
  profile.layers
    .filter((layer) => layer.enabled)
    .sort((left, right) => left.order - right.order)
    .forEach((layer) => {
      layer.definitions.forEach((item) => {
        if (item.operation === "define") {
          if (resolved.has(item.id)) {
            conflicts.push({
              id: `duplicate:${layer.id}:${item.id}`,
              layerId: layer.id,
              definitionId: item.id,
              severity: "error",
              message: `稳定定义 ${item.id} 已存在；请改为显式覆盖。`,
            });
            return;
          }
          resolved.set(item.id, {
            ...item,
            layerId: layer.id,
            layerName: layer.name,
            overriddenDefinitionId: null,
          });
          return;
        }
        if (!item.targetId || !resolved.has(item.targetId)) {
          conflicts.push({
            id: `missing-target:${layer.id}:${item.id}`,
            layerId: layer.id,
            definitionId: item.id,
            severity: "error",
            message: `${item.operation === "override" ? "覆盖" : "扩展"}目标不存在：${item.targetId || "未指定"}。`,
          });
          return;
        }
        const targetDefinition = resolved.get(item.targetId);
        if (item.operation === "override" && item.id !== item.targetId) {
          conflicts.push({
            id: `override-id:${layer.id}:${item.id}`,
            layerId: layer.id,
            definitionId: item.id,
            severity: "error",
            message: `覆盖定义必须复用目标稳定 ID：${item.targetId}。`,
          });
          return;
        }
        if (
          item.operation === "override" &&
          targetDefinition &&
          (item.category !== targetDefinition.category ||
            item.scope !== targetDefinition.scope ||
            item.valueType !== targetDefinition.valueType)
        ) {
          conflicts.push({
            id: `override-shape:${layer.id}:${item.id}`,
            layerId: layer.id,
            definitionId: item.id,
            severity: "error",
            message: `覆盖定义必须保留目标的类别、作用对象和字段类型：${item.targetId}。`,
          });
          return;
        }
        if (item.operation === "override") {
          resolved.delete(item.targetId);
        }
        if (resolved.has(item.id)) {
          conflicts.push({
            id: `duplicate-extension:${layer.id}:${item.id}`,
            layerId: layer.id,
            definitionId: item.id,
            severity: "error",
            message: `扩展定义 ${item.id} 与已有定义冲突。`,
          });
          return;
        }
        resolved.set(item.id, {
          ...item,
          layerId: layer.id,
          layerName: layer.name,
          overriddenDefinitionId: item.targetId,
        });
      });
    });
  return {
    definitions: Object.freeze([...resolved.values()]),
    conflicts: Object.freeze(conflicts),
  };
}

export function isInspirationAdopted(
  library: InspirationLibrary,
  inspirationId: string,
): boolean {
  return library.adoptions.some((item) => item.inspirationId === inspirationId);
}
