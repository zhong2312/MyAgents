import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import { dirname, join } from "path";

import {
  NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
  powerCatalogEntitySchema,
  powerCatalogSchema,
  powerConnectionSchema,
  powerConnectionsSchema,
  powerDesignContractSchema,
  powerEntityReferenceSchema,
  powerMetricDimensionSchema,
  powerProgressionStateSchema,
  powerProgressionTrackSchema,
  powerProgressionTransitionSchema,
  powerSystemIndexSchema,
  powerSystemMetaSchema,
  powerSystemRecordSchema,
  type PowerCatalog,
  type PowerCatalogEntity,
  type PowerConnection,
  type PowerConnections,
  type PowerDesignContract,
  type PowerEntityReference,
  type PowerMetricDimension,
  type PowerProgressionState,
  type PowerProgressionTrack,
  type PowerProgressionTransition,
  type PowerSystemIndex,
  type PowerSystemRecord,
  type PowerTruthMetadata,
} from "../shared/novel-power-system-schema";
import { withFileLock } from "./utils/file-lock";

const POWER_ROOT = "world/power-systems";
const DRAFT_ROOT = `${POWER_ROOT}/drafts`;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface PowerDraftDesignBrief {
  readonly narrativePurpose: string;
  readonly coreMechanism: string;
  readonly progressionModel: string;
  readonly costs: readonly string[];
  readonly comparisonRule: string;
  readonly exceptionBoundaries: readonly string[];
}

export interface PowerDraftValidationReceipt {
  readonly token: string;
  readonly contentHash: string;
  readonly revision: number;
  readonly validatedAt: string;
}

export interface PowerSystemDraft {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly systemId: string;
  readonly operation: "create" | "modify";
  readonly designBrief: PowerDraftDesignBrief;
  readonly record: PowerSystemRecord;
  readonly pageMarkdown: string;
  readonly catalogEntities: readonly PowerCatalogEntity[];
  readonly connections: readonly PowerConnection[];
  readonly source: {
    readonly sessionId: string;
    readonly promptId: string;
    readonly promptVersion: string;
  };
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validation: PowerDraftValidationReceipt | null;
  readonly submittedProposalId: string | null;
}

export interface PowerDraftChange {
  readonly id: string;
  readonly targetPath: string;
  readonly operation: "create" | "modify";
  readonly summary: string;
  readonly content: string;
}

export interface PowerDraftSource {
  readonly sessionId: string;
  readonly promptId: string;
  readonly promptVersion: string;
}

type TruthMetadataInput = Partial<{
  settingLevel: string;
  domainCategories: string[];
  spatialScopeIds: string[];
  timeFrom: string;
  timeTo: string;
  authority: PowerTruthMetadata["authority"];
  canon: PowerTruthMetadata["canon"];
  revealStage: string;
}>;

export interface PowerDraftOverviewPatch {
  readonly name?: string;
  readonly aliases?: string[];
  readonly summary?: string;
  readonly status?: PowerSystemRecord["status"];
  readonly designContract?: Partial<PowerDesignContract>;
  readonly dimensions?: Array<
    Partial<PowerMetricDimension> &
      Pick<PowerMetricDimension, "id" | "name" | "category">
  >;
  readonly metadata?: TruthMetadataInput;
  readonly pageMarkdown?: string;
}

export interface PowerDraftCatalogEntityInput {
  readonly id: string;
  readonly name: string;
  readonly kind: PowerCatalogEntity["kind"];
  readonly aliases?: string[];
  readonly subtypeId?: string;
  readonly summary?: string;
  readonly tags?: string[];
  readonly metadata?: TruthMetadataInput;
  readonly details?: Record<string, unknown>;
}

export interface PowerDraftStateInput {
  readonly id: string;
  readonly name: string;
  readonly aliases?: string[];
  readonly stateType?: PowerProgressionState["stateType"];
  readonly summary?: string;
  readonly order?: number;
  readonly entryConditions?: string[];
  readonly maintenanceConditions?: string[];
  readonly exitConditions?: string[];
  readonly baseQualities?: Array<{
    dimensionId: string;
    value: number | string | null;
    note?: string;
  }>;
  readonly baseBoundaries?: Array<{
    dimensionId: string;
    value: number | string | null;
    note?: string;
  }>;
  readonly cognition?: Partial<PowerProgressionState["contract"]["cognition"]>;
  readonly stability?: string;
  readonly risks?: string[];
  readonly metadata?: TruthMetadataInput;
}

export interface PowerDraftTransitionInput {
  readonly id: string;
  readonly name: string;
  readonly fromStateId?: string | null;
  readonly toStateId: string;
  readonly transitionType?: PowerProgressionTransition["transitionType"];
  readonly conditions?: string[];
  readonly qualityCarryover?: PowerProgressionTransition["qualityCarryover"];
  readonly qualityRule?: string;
  readonly outcomes?: string[];
  readonly failureModes?: string[];
  readonly reversible?: boolean;
}

export interface PowerDraftProgressionInput {
  readonly track: {
    readonly id: string;
    readonly name?: string;
    readonly subtypeId?: string;
    readonly summary?: string;
    readonly mode?: PowerProgressionTrack["mode"];
    readonly metadata?: TruthMetadataInput;
  };
  readonly states?: PowerDraftStateInput[];
  readonly transitions?: PowerDraftTransitionInput[];
}

export interface PowerDraftConnectionInput {
  readonly id: string;
  readonly kind: PowerConnection["kind"];
  readonly source: PowerEntityReference;
  readonly target: PowerEntityReference;
  readonly conditions?: string[];
  readonly note?: string;
  readonly metadata?: TruthMetadataInput;
  readonly details?: Record<string, unknown>;
}

export type PowerDraftRemoveScope =
  | "catalog"
  | "track"
  | "state"
  | "transition"
  | "connection";

function draftPath(workspace: string, draftId: string): string {
  assertId(draftId, "draftId");
  return join(workspace, ...DRAFT_ROOT.split("/"), draftId, "draft.json");
}

function projectPath(workspace: string, relativePath: string): string {
  return join(workspace, ...relativePath.split("/"));
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} 只能使用小写字母、数字和连字符`);
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultTruthMetadata(
  input: TruthMetadataInput = {},
): PowerTruthMetadata {
  return {
    settingLevel: input.settingLevel?.trim() ?? "",
    domainCategories: input.domainCategories ?? [],
    spatialScopeIds: input.spatialScopeIds ?? [],
    timeScope: {
      from: input.timeFrom?.trim() ?? "",
      to: input.timeTo?.trim() ?? "",
    },
    authority: input.authority ?? "default",
    canon: input.canon ?? "draft",
    revealStage: input.revealStage?.trim() ?? "",
    sourceRefs: [],
  };
}

function mergeTruthMetadata(
  existing: PowerTruthMetadata | undefined,
  input: TruthMetadataInput | undefined,
): PowerTruthMetadata {
  if (!existing) return defaultTruthMetadata(input);
  if (!input) return existing;
  return {
    ...existing,
    ...(input.settingLevel !== undefined
      ? { settingLevel: input.settingLevel.trim() }
      : {}),
    ...(input.domainCategories !== undefined
      ? { domainCategories: input.domainCategories }
      : {}),
    ...(input.spatialScopeIds !== undefined
      ? { spatialScopeIds: input.spatialScopeIds }
      : {}),
    timeScope: {
      from: input.timeFrom?.trim() ?? existing.timeScope.from,
      to: input.timeTo?.trim() ?? existing.timeScope.to,
    },
    ...(input.authority !== undefined ? { authority: input.authority } : {}),
    ...(input.canon !== undefined ? { canon: input.canon } : {}),
    ...(input.revealStage !== undefined
      ? { revealStage: input.revealStage.trim() }
      : {}),
  };
}

function defaultDesignContract(typeId: string): PowerDesignContract {
  if (typeId === "soft-system") {
    return {
      explanation: "mysterious",
      progression: "none",
      costPolicy: "optional",
      comparison: "incomparable",
      theoryPolicy: "unknown",
    };
  }
  if (typeId === "superpower" || typeId === "lineage") {
    return {
      explanation: "partial",
      progression: "event-driven",
      costPolicy: "recommended",
      comparison: "contextual",
      theoryPolicy: "partial",
    };
  }
  return {
    explanation: "explicit",
    progression: typeId === "blank" ? "none" : "multi-track",
    costPolicy: "recommended",
    comparison: "contextual",
    theoryPolicy: "explicit",
  };
}

function defaultDimensions(): PowerMetricDimension[] {
  return [
    {
      id: "quality-stability",
      name: "稳定性",
      category: "quality",
      measurement: "descriptive",
      unit: "",
      lowLabel: "脆弱",
      highLabel: "稳定",
      description: "同一状态下力量结构保持可靠的程度。",
    },
    {
      id: "quality-control",
      name: "控制精度",
      category: "quality",
      measurement: "descriptive",
      unit: "",
      lowLabel: "粗放",
      highLabel: "精密",
      description: "同一状态下对力量进行精细操控的程度。",
    },
    {
      id: "boundary-capacity",
      name: "承载上限",
      category: "boundary",
      measurement: "descriptive",
      unit: "",
      lowLabel: "有限",
      highLabel: "庞大",
      description: "当前状态能够稳定承载的力量上限。",
    },
    {
      id: "boundary-throughput",
      name: "瞬时吞吐",
      category: "boundary",
      measurement: "descriptive",
      unit: "",
      lowLabel: "缓慢",
      highLabel: "爆发",
      description: "当前状态单次能够安全调动的力量规模。",
    },
  ];
}

function defaultTrackMode(typeId: string): PowerProgressionTrack["mode"] {
  if (typeId === "superpower" || typeId === "lineage") return "event-driven";
  if (typeId === "soft-system" || typeId === "blank") return "unordered";
  return "ordered";
}

function createRecord(input: {
  id: string;
  name: string;
  typeId: string;
  summary?: string;
}): PowerSystemRecord {
  const now = new Date().toISOString();
  const tracks =
    input.typeId === "blank" || input.typeId === "soft-system"
      ? []
      : [
          {
            id: "primary-track",
            name: "主成长路径",
            subtypeId: "",
            summary: "",
            mode: defaultTrackMode(input.typeId),
            states: [],
            transitions: [],
            metadata: defaultTruthMetadata(),
          },
        ];
  return powerSystemRecordSchema.parse({
    schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
    id: input.id,
    name: input.name.trim(),
    aliases: [],
    typeId: input.typeId,
    status: "draft",
    summary: input.summary?.trim() ?? "",
    designContract: defaultDesignContract(input.typeId),
    tracks,
    dimensions: defaultDimensions(),
    metadata: defaultTruthMetadata(),
    createdAt: now,
    updatedAt: now,
  });
}

function createPage(
  record: PowerSystemRecord,
  brief: PowerDraftDesignBrief,
): string {
  return `# ${record.name}\n\n## 叙事功能\n\n${brief.narrativePurpose}\n\n## 核心机制\n\n${brief.coreMechanism}\n\n## 成长方式\n\n${brief.progressionModel}\n\n## 代价\n\n${brief.costs.map((item) => `- ${item}`).join("\n") || "- 待定义"}\n\n## 比较规则\n\n${brief.comparisonRule}\n\n## 例外边界\n\n${brief.exceptionBoundaries.map((item) => `- ${item}`).join("\n") || "- 无"}\n`;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readParsed<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const content = await fs.readFile(path, "utf8");
  return schema.parse(JSON.parse(content));
}

function parseDraft(value: unknown): PowerSystemDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("力量体系草稿格式错误");
  }
  const draft = value as Record<string, unknown>;
  if (
    draft.schemaVersion !== 1 ||
    typeof draft.draftId !== "string" ||
    typeof draft.systemId !== "string" ||
    (draft.operation !== "create" && draft.operation !== "modify") ||
    typeof draft.pageMarkdown !== "string" ||
    !Array.isArray(draft.catalogEntities) ||
    !Array.isArray(draft.connections) ||
    typeof draft.revision !== "number" ||
    typeof draft.createdAt !== "string" ||
    typeof draft.updatedAt !== "string"
  ) {
    throw new Error("力量体系草稿缺少必填字段");
  }
  assertId(draft.draftId, "draftId");
  assertId(draft.systemId, "systemId");
  const brief = draft.designBrief as PowerDraftDesignBrief;
  if (
    !brief ||
    typeof brief.narrativePurpose !== "string" ||
    typeof brief.coreMechanism !== "string" ||
    typeof brief.progressionModel !== "string" ||
    !Array.isArray(brief.costs) ||
    typeof brief.comparisonRule !== "string" ||
    !Array.isArray(brief.exceptionBoundaries)
  ) {
    throw new Error("力量体系草稿缺少已确认的设计摘要");
  }
  const source = draft.source as PowerDraftSource;
  if (
    !source ||
    typeof source.sessionId !== "string" ||
    typeof source.promptId !== "string" ||
    typeof source.promptVersion !== "string"
  ) {
    throw new Error("力量体系草稿缺少来源信息");
  }
  const validation = draft.validation as PowerDraftValidationReceipt | null;
  if (
    validation !== null &&
    (!validation ||
      typeof validation.token !== "string" ||
      typeof validation.contentHash !== "string" ||
      typeof validation.revision !== "number" ||
      typeof validation.validatedAt !== "string")
  ) {
    throw new Error("力量体系草稿校验回执格式错误");
  }
  return {
    schemaVersion: 1,
    draftId: draft.draftId,
    systemId: draft.systemId,
    operation: draft.operation,
    designBrief: brief,
    record: powerSystemRecordSchema.parse(draft.record),
    pageMarkdown: draft.pageMarkdown,
    catalogEntities: draft.catalogEntities.map((entity) =>
      powerCatalogEntitySchema.parse(entity),
    ),
    connections: draft.connections.map((connection) =>
      powerConnectionSchema.parse(connection),
    ),
    source,
    revision: draft.revision,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    validation,
    submittedProposalId:
      typeof draft.submittedProposalId === "string"
        ? draft.submittedProposalId
        : null,
  };
}

async function writeDraft(
  workspace: string,
  draft: PowerSystemDraft,
): Promise<void> {
  const path = draftPath(workspace, draft.draftId);
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temporary, serializeJson(draft), "utf8");
  await fs.rename(temporary, path);
}

async function withPowerDraftLock<T>(
  workspace: string,
  draftId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = draftPath(workspace, draftId);
  await fs.mkdir(dirname(path), { recursive: true });
  return withFileLock({ lockPath: `${path}.lock` }, operation);
}

async function mutatePowerDraft(
  workspace: string,
  draftId: string,
  operation: (
    draft: PowerSystemDraft,
  ) => PowerSystemDraft | Promise<PowerSystemDraft>,
): Promise<PowerSystemDraft> {
  return withPowerDraftLock(workspace, draftId, async () => {
    const current = await loadPowerDraft(workspace, draftId);
    const next = await operation(current);
    await writeDraft(workspace, next);
    return next;
  });
}

function nextDraft(
  draft: PowerSystemDraft,
  patch: Partial<PowerSystemDraft>,
): PowerSystemDraft {
  if (draft.submittedProposalId) {
    throw new Error("该草稿已经提交；如需继续设计，请创建新草稿");
  }
  return parseDraft({
    ...draft,
    ...patch,
    revision: draft.revision + 1,
    updatedAt: new Date().toISOString(),
    validation: null,
  });
}

export async function loadPowerDraft(
  workspace: string,
  draftId: string,
): Promise<PowerSystemDraft> {
  const content = await fs.readFile(draftPath(workspace, draftId), "utf8");
  return parseDraft(JSON.parse(content));
}

export async function listPowerDrafts(workspace: string): Promise<
  Array<{
    draftId: string;
    systemId: string;
    name: string;
    operation: PowerSystemDraft["operation"];
    revision: number;
    validated: boolean;
    submittedProposalId: string | null;
    updatedAt: string;
  }>
> {
  const root = projectPath(workspace, DRAFT_ROOT);
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const drafts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
    try {
      const draft = await loadPowerDraft(workspace, entry.name);
      drafts.push({
        draftId: draft.draftId,
        systemId: draft.systemId,
        name: draft.record.name,
        operation: draft.operation,
        revision: draft.revision,
        validated: draft.validation?.revision === draft.revision,
        submittedProposalId: draft.submittedProposalId,
        updatedAt: draft.updatedAt,
      });
    } catch {
      // Invalid drafts are ignored here and remain inspectable on disk.
    }
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createPowerDraft(
  workspace: string,
  input: {
    draftId?: string;
    systemId: string;
    name: string;
    typeId: string;
    summary?: string;
    designBrief: PowerDraftDesignBrief;
  },
  source: PowerDraftSource,
): Promise<PowerSystemDraft> {
  assertId(input.systemId, "systemId");
  assertId(input.typeId, "typeId");
  const draftId =
    input.draftId?.trim() ||
    `draft-${input.systemId}-${randomUUID().slice(0, 8)}`;
  assertId(draftId, "draftId");
  if (!input.name.trim()) throw new Error("力量体系名称不能为空");
  if (
    !input.designBrief.narrativePurpose.trim() ||
    !input.designBrief.coreMechanism.trim() ||
    !input.designBrief.progressionModel.trim() ||
    !input.designBrief.comparisonRule.trim()
  ) {
    throw new Error("创建草稿前必须提供作者已确认的完整设计摘要");
  }
  return withPowerDraftLock(workspace, draftId, async () => {
    if (await readOptional(draftPath(workspace, draftId))) {
      throw new Error(`力量体系草稿已存在：${draftId}`);
    }
    const meta = await readParsed(
      projectPath(workspace, `${POWER_ROOT}/meta.json`),
      powerSystemMetaSchema,
    );
    if (!meta.systemTypes.some((type) => type.id === input.typeId)) {
      throw new Error(`未知力量体系类型：${input.typeId}`);
    }
    const index = await readParsed(
      projectPath(workspace, `${POWER_ROOT}/index.json`),
      powerSystemIndexSchema,
    );
    const existing = index.systems.find((entry) => entry.id === input.systemId);
    let record: PowerSystemRecord;
    let pageMarkdown: string;
    if (existing) {
      record = await readParsed(
        projectPath(workspace, existing.recordPath),
        powerSystemRecordSchema,
      );
      pageMarkdown =
        (await readOptional(projectPath(workspace, existing.pagePath))) ??
        createPage(record, input.designBrief);
    } else {
      record = createRecord({
        id: input.systemId,
        name: input.name,
        typeId: input.typeId,
        summary: input.summary,
      });
      pageMarkdown = createPage(record, input.designBrief);
    }
    const now = new Date().toISOString();
    const draft = parseDraft({
      schemaVersion: 1,
      draftId,
      systemId: input.systemId,
      operation: existing ? "modify" : "create",
      designBrief: input.designBrief,
      record,
      pageMarkdown,
      catalogEntities: [],
      connections: [],
      source,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      validation: null,
      submittedProposalId: null,
    });
    await writeDraft(workspace, draft);
    return draft;
  });
}

export async function updatePowerDraftOverview(
  workspace: string,
  draftId: string,
  patch: PowerDraftOverviewPatch,
): Promise<PowerSystemDraft> {
  return mutatePowerDraft(workspace, draftId, (draft) => {
    const now = new Date().toISOString();
    const dimensionsById = new Map(
      draft.record.dimensions.map((dimension) => [dimension.id, dimension]),
    );
    for (const dimension of patch.dimensions ?? []) {
      dimensionsById.set(
        dimension.id,
        powerMetricDimensionSchema.parse({
          measurement: "descriptive",
          unit: "",
          lowLabel: "",
          highLabel: "",
          description: "",
          ...dimensionsById.get(dimension.id),
          ...dimension,
        }),
      );
    }
    const dimensions = [...dimensionsById.values()];
    const record = powerSystemRecordSchema.parse({
      ...draft.record,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.designContract !== undefined
        ? {
            designContract: powerDesignContractSchema.parse({
              ...draft.record.designContract,
              ...patch.designContract,
            }),
          }
        : {}),
      dimensions,
      ...(patch.metadata !== undefined
        ? {
            metadata: mergeTruthMetadata(draft.record.metadata, patch.metadata),
          }
        : {}),
      updatedAt: now,
    });
    const next = nextDraft(draft, {
      record,
      ...(patch.pageMarkdown !== undefined
        ? { pageMarkdown: patch.pageMarkdown }
        : {}),
    });
    return next;
  });
}

function normalizeCatalogEntity(
  input: PowerDraftCatalogEntityInput,
  existing?: PowerCatalogEntity,
): PowerCatalogEntity {
  assertId(input.id, "catalog entity id");
  const details = input.details ?? {};
  const base = {
    id: input.id,
    name: input.name,
    aliases: input.aliases ?? existing?.aliases ?? [],
    subtypeId: input.subtypeId ?? existing?.subtypeId ?? "",
    summary: input.summary ?? existing?.summary ?? "",
    tags: input.tags ?? existing?.tags ?? [],
    metadata:
      input.metadata !== undefined
        ? mergeTruthMetadata(existing?.metadata, input.metadata)
        : (existing?.metadata ?? defaultTruthMetadata()),
  };
  const value: Record<string, unknown> = {
    ...(existing ?? {}),
    ...base,
    ...details,
    kind: input.kind,
  };
  switch (input.kind) {
    case "foundation":
      Object.assign(value, {
        foundationType: value.foundationType ?? "unknown",
        availability: value.availability ?? "unknown",
        manifestation: value.manifestation ?? "",
      });
      break;
    case "medium":
      Object.assign(value, {
        mediumType: value.mediumType ?? "unknown",
        carrier: value.carrier ?? "",
        circulation: value.circulation ?? "",
        storage: value.storage ?? "",
        loss: value.loss ?? "",
      });
      break;
    case "principle":
      Object.assign(value, {
        principleType: value.principleType ?? "custom",
        scope: value.scope ?? "system",
        statements: value.statements ?? [],
        conditions: value.conditions ?? [],
        exceptions: value.exceptions ?? [],
        priority: value.priority ?? 0,
      });
      break;
    case "resource":
      Object.assign(value, {
        resourceType: value.resourceType ?? "other",
        measurement: value.measurement ?? "descriptive",
        unit: value.unit ?? "",
        qualityDimensions: value.qualityDimensions ?? [],
        replenishment: value.replenishment ?? "",
        scarcity: value.scarcity ?? "",
      });
      break;
    case "theory":
      Object.assign(value, {
        representationType: value.representationType ?? "unknown",
        substrateRefs: value.substrateRefs ?? [],
        topology: value.topology ?? {
          spatialDimensions: null,
          nodeDefinition: "",
          connectionDefinition: "",
          structure: "",
        },
        operations: value.operations ?? [],
        controlStrategy: value.controlStrategy ?? "",
        complexity: value.complexity ?? {
          memory: "unknown",
          parallelism: "unknown",
          abstraction: "unknown",
          dynamism: "unknown",
        },
        assumptions: value.assumptions ?? [],
        invariants: value.invariants ?? [],
        failureModes: value.failureModes ?? [],
      });
      break;
    case "method": {
      const theoryIds = Array.isArray(details.theoryIds)
        ? details.theoryIds.filter((id): id is string => typeof id === "string")
        : [];
      Object.assign(value, {
        acquisition: value.acquisition ?? "unknown",
        roles: value.roles ?? [],
        theoryRefs:
          value.theoryRefs ??
          theoryIds.map((targetId) => ({
            namespace: "catalog",
            kind: "theory",
            targetId,
          })),
        procedure: value.procedure ?? "",
        phases: value.phases ?? [],
        outputs: value.outputs ?? [],
        failureConsequences: value.failureConsequences ?? [],
      });
      break;
    }
    case "capability":
      Object.assign(value, {
        capabilityType: value.capabilityType ?? "custom",
        activation: value.activation ?? "active",
        effect: value.effect ?? "",
        target: value.target ?? "",
        range: value.range ?? "",
        duration: value.duration ?? "",
        costs: value.costs ?? [],
        limitations: value.limitations ?? [],
        sideEffects: value.sideEffects ?? [],
        countermeasures: value.countermeasures ?? [],
      });
      break;
  }
  return powerCatalogEntitySchema.parse(value);
}

export async function upsertPowerDraftCatalogEntities(
  workspace: string,
  draftId: string,
  inputs: readonly PowerDraftCatalogEntityInput[],
): Promise<PowerSystemDraft> {
  return mutatePowerDraft(workspace, draftId, async (draft) => {
    const catalog = await readParsed(
      projectPath(workspace, `${POWER_ROOT}/catalog.json`),
      powerCatalogSchema,
    );
    const currentEntities = new Map(
      [
        ...catalog.foundations,
        ...catalog.mediums,
        ...catalog.principles,
        ...catalog.resources,
        ...catalog.theories,
        ...catalog.methods,
        ...catalog.capabilities,
      ].map((entity) => [entity.id, entity]),
    );
    const byId = new Map(
      draft.catalogEntities.map((entity) => [entity.id, entity]),
    );
    for (const input of inputs) {
      const existing = byId.get(input.id) ?? currentEntities.get(input.id);
      const entity = normalizeCatalogEntity(input, existing);
      if (existing && existing.kind !== entity.kind) {
        throw new Error(
          `共享对象 ${entity.id} 不能从 ${existing.kind} 改为 ${entity.kind}`,
        );
      }
      byId.set(entity.id, entity);
    }
    const next = nextDraft(draft, { catalogEntities: [...byId.values()] });
    return next;
  });
}

function conditionsFromText(
  values: readonly string[] | undefined,
  prefix: string,
) {
  return {
    mode: "all" as const,
    clauses: (values ?? []).map((text, index) => ({
      id: `${prefix}-${index + 1}`,
      subjectRef: null,
      subject: text,
      field: "",
      operator: "exists" as const,
      value: "",
      note: "",
    })),
  };
}

function normalizeState(
  input: PowerDraftStateInput,
  existing: PowerProgressionState | undefined,
  defaultOrder: number,
): PowerProgressionState {
  const cognition = {
    representationType: "unknown" as const,
    description: "",
    memoryLoad: "unknown" as const,
    parallelism: "unknown" as const,
    abstraction: "unknown" as const,
    dynamism: "unknown" as const,
    spatialDimensions: null,
    requiredSkills: [],
    breakthroughInsight: "",
    ...(existing?.contract.cognition ?? {}),
    ...(input.cognition ?? {}),
  };
  return powerProgressionStateSchema.parse({
    id: input.id,
    name: input.name,
    aliases: input.aliases ?? existing?.aliases ?? [],
    stateType: input.stateType ?? existing?.stateType ?? "stage",
    summary: input.summary ?? existing?.summary ?? "",
    order: input.order ?? existing?.order ?? defaultOrder,
    contract: {
      entryConditions:
        input.entryConditions !== undefined
          ? conditionsFromText(input.entryConditions, `${input.id}-entry`)
          : (existing?.contract.entryConditions ??
            conditionsFromText([], "entry")),
      maintenanceConditions:
        input.maintenanceConditions !== undefined
          ? conditionsFromText(
              input.maintenanceConditions,
              `${input.id}-maintain`,
            )
          : (existing?.contract.maintenanceConditions ??
            conditionsFromText([], "maintain")),
      exitConditions:
        input.exitConditions !== undefined
          ? conditionsFromText(input.exitConditions, `${input.id}-exit`)
          : (existing?.contract.exitConditions ??
            conditionsFromText([], "exit")),
      baseQualities:
        input.baseQualities?.map((value) => ({
          ...value,
          note: value.note ?? "",
        })) ??
        existing?.contract.baseQualities ??
        [],
      baseBoundaries:
        input.baseBoundaries?.map((value) => ({
          ...value,
          note: value.note ?? "",
        })) ??
        existing?.contract.baseBoundaries ??
        [],
      cognition,
      stability: input.stability ?? existing?.contract.stability ?? "",
      risks: input.risks ?? existing?.contract.risks ?? [],
    },
    metadata:
      input.metadata !== undefined
        ? mergeTruthMetadata(existing?.metadata, input.metadata)
        : (existing?.metadata ?? defaultTruthMetadata()),
  });
}

function normalizeTransition(
  input: PowerDraftTransitionInput,
  existing: PowerProgressionTransition | undefined,
): PowerProgressionTransition {
  return powerProgressionTransitionSchema.parse({
    id: input.id,
    name: input.name,
    fromStateId: input.fromStateId ?? existing?.fromStateId ?? null,
    toStateId: input.toStateId,
    transitionType:
      input.transitionType ?? existing?.transitionType ?? "advance",
    conditions:
      input.conditions !== undefined
        ? conditionsFromText(input.conditions, `${input.id}-condition`)
        : (existing?.conditions ?? conditionsFromText([], "condition")),
    qualityCarryover:
      input.qualityCarryover ?? existing?.qualityCarryover ?? "preserve",
    qualityRule: input.qualityRule ?? existing?.qualityRule ?? "",
    outcomes: input.outcomes ?? existing?.outcomes ?? [],
    failureModes: input.failureModes ?? existing?.failureModes ?? [],
    reversible: input.reversible ?? existing?.reversible ?? false,
  });
}

export async function upsertPowerDraftProgression(
  workspace: string,
  draftId: string,
  input: PowerDraftProgressionInput,
): Promise<PowerSystemDraft> {
  return mutatePowerDraft(workspace, draftId, (draft) => {
    assertId(input.track.id, "track id");
    const existing = draft.record.tracks.find(
      (track) => track.id === input.track.id,
    );
    if (!existing && !input.track.name?.trim()) {
      throw new Error("新建成长路径时必须提供名称");
    }
    const states = new Map(
      (existing?.states ?? []).map((state) => [state.id, state]),
    );
    for (const stateInput of input.states ?? []) {
      assertId(stateInput.id, "state id");
      states.set(
        stateInput.id,
        normalizeState(stateInput, states.get(stateInput.id), states.size),
      );
    }
    const transitions = new Map(
      (existing?.transitions ?? []).map((transition) => [
        transition.id,
        transition,
      ]),
    );
    for (const transitionInput of input.transitions ?? []) {
      assertId(transitionInput.id, "transition id");
      transitions.set(
        transitionInput.id,
        normalizeTransition(
          transitionInput,
          transitions.get(transitionInput.id),
        ),
      );
    }
    const track = powerProgressionTrackSchema.parse({
      id: input.track.id,
      name: input.track.name ?? existing?.name,
      subtypeId: input.track.subtypeId ?? existing?.subtypeId ?? "",
      summary: input.track.summary ?? existing?.summary ?? "",
      mode:
        input.track.mode ??
        existing?.mode ??
        defaultTrackMode(draft.record.typeId),
      states: [...states.values()].sort((a, b) => a.order - b.order),
      transitions: [...transitions.values()],
      metadata:
        input.track.metadata !== undefined
          ? mergeTruthMetadata(existing?.metadata, input.track.metadata)
          : (existing?.metadata ?? defaultTruthMetadata()),
    });
    const tracks = draft.record.tracks.filter((item) => item.id !== track.id);
    const record = powerSystemRecordSchema.parse({
      ...draft.record,
      tracks: [...tracks, track],
      updatedAt: new Date().toISOString(),
    });
    const next = nextDraft(draft, { record });
    return next;
  });
}

function normalizeConnection(
  input: PowerDraftConnectionInput,
  existing?: PowerConnection,
): PowerConnection {
  const details = input.details ?? {};
  const base = {
    id: input.id,
    kind: input.kind,
    source: powerEntityReferenceSchema.parse(input.source),
    target: powerEntityReferenceSchema.parse(input.target),
    conditions:
      input.conditions !== undefined
        ? conditionsFromText(input.conditions, `${input.id}-condition`)
        : (existing?.conditions ??
          conditionsFromText([], `${input.id}-condition`)),
    note: input.note ?? existing?.note ?? "",
    metadata:
      input.metadata !== undefined
        ? mergeTruthMetadata(existing?.metadata, input.metadata)
        : (existing?.metadata ?? defaultTruthMetadata()),
  };
  const value: Record<string, unknown> = {
    ...(existing ?? {}),
    ...base,
    ...details,
  };
  switch (input.kind) {
    case "association":
      Object.assign(value, {
        relation: value.relation ?? "uses",
        compatibility: value.compatibility ?? "native",
      });
      break;
    case "method-application":
      Object.assign(value, {
        role: value.role ?? "advance",
        compatibility: value.compatibility ?? "native",
        theoryRef: value.theoryRef ?? null,
        executionModel: value.executionModel ?? "",
        efficiency: value.efficiency ?? {
          mode: "qualitative",
          value: null,
          note: "",
        },
        qualityEffects: value.qualityEffects ?? [],
        boundaryEffects: value.boundaryEffects ?? [],
        outcomes: value.outcomes ?? [],
        failureModes: value.failureModes ?? [],
      });
      break;
    case "resource-requirement":
      Object.assign(value, {
        purpose: value.purpose ?? "develop",
        amount: value.amount ?? {
          mode: "descriptive",
          minimum: null,
          maximum: null,
          value: "",
          unit: "",
        },
        quality: value.quality ?? "",
        consumed: value.consumed ?? true,
        substituteRefs: value.substituteRefs ?? [],
        shortageConsequence: value.shortageConsequence ?? "",
      });
      break;
    case "capability-access":
      Object.assign(value, {
        accessMode: value.accessMode ?? "learnable",
        mastery: value.mastery ?? "available",
      });
      break;
    case "system-interaction":
      Object.assign(value, {
        interaction: value.interaction ?? "compatible",
        effect: value.effect ?? "",
      });
      break;
  }
  return powerConnectionSchema.parse(value);
}

export async function upsertPowerDraftConnections(
  workspace: string,
  draftId: string,
  inputs: readonly PowerDraftConnectionInput[],
): Promise<PowerSystemDraft> {
  return mutatePowerDraft(workspace, draftId, async (draft) => {
    const current = await readParsed(
      projectPath(workspace, `${POWER_ROOT}/connections.json`),
      powerConnectionsSchema,
    );
    const currentById = new Map(
      current.connections.map((connection) => [connection.id, connection]),
    );
    const byId = new Map(
      draft.connections.map((connection) => [connection.id, connection]),
    );
    for (const input of inputs) {
      assertId(input.id, "connection id");
      const existing = byId.get(input.id) ?? currentById.get(input.id);
      const connection = normalizeConnection(input, existing);
      if (existing && existing.kind !== connection.kind) {
        throw new Error(
          `连接 ${connection.id} 不能从 ${existing.kind} 改为 ${connection.kind}`,
        );
      }
      byId.set(connection.id, connection);
    }
    const next = nextDraft(draft, { connections: [...byId.values()] });
    return next;
  });
}

export async function removePowerDraftEntities(
  workspace: string,
  draftId: string,
  scope: PowerDraftRemoveScope,
  ids: readonly string[],
  trackId?: string,
): Promise<PowerSystemDraft> {
  return mutatePowerDraft(workspace, draftId, (draft) => {
    const removing = new Set(ids);
    let patch: Partial<PowerSystemDraft> = {};
    if (scope === "catalog") {
      patch = {
        catalogEntities: draft.catalogEntities.filter(
          (item) => !removing.has(item.id),
        ),
      };
    } else if (scope === "connection") {
      patch = {
        connections: draft.connections.filter((item) => !removing.has(item.id)),
      };
    } else if (scope === "track") {
      patch = {
        record: powerSystemRecordSchema.parse({
          ...draft.record,
          tracks: draft.record.tracks.filter((item) => !removing.has(item.id)),
          updatedAt: new Date().toISOString(),
        }),
      };
    } else {
      if (!trackId) throw new Error("删除状态或转换时必须提供 trackId");
      const track = draft.record.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error(`成长路径不存在：${trackId}`);
      const updatedTrack = powerProgressionTrackSchema.parse({
        ...track,
        ...(scope === "state"
          ? { states: track.states.filter((item) => !removing.has(item.id)) }
          : {
              transitions: track.transitions.filter(
                (item) => !removing.has(item.id),
              ),
            }),
      });
      patch = {
        record: powerSystemRecordSchema.parse({
          ...draft.record,
          tracks: draft.record.tracks.map((item) =>
            item.id === trackId ? updatedTrack : item,
          ),
          updatedAt: new Date().toISOString(),
        }),
      };
    }
    const next = nextDraft(draft, patch);
    return next;
  });
}

function mergeCatalog(
  current: PowerCatalog,
  entities: readonly PowerCatalogEntity[],
): PowerCatalog {
  const all = new Map<string, PowerCatalogEntity>();
  for (const entity of [
    ...current.foundations,
    ...current.mediums,
    ...current.principles,
    ...current.resources,
    ...current.theories,
    ...current.methods,
    ...current.capabilities,
  ]) {
    all.set(entity.id, entity);
  }
  for (const entity of entities) all.set(entity.id, entity);
  const values = [...all.values()];
  return powerCatalogSchema.parse({
    schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
    foundations: values.filter((item) => item.kind === "foundation"),
    mediums: values.filter((item) => item.kind === "medium"),
    principles: values.filter((item) => item.kind === "principle"),
    resources: values.filter((item) => item.kind === "resource"),
    theories: values.filter((item) => item.kind === "theory"),
    methods: values.filter((item) => item.kind === "method"),
    capabilities: values.filter((item) => item.kind === "capability"),
  });
}

function mergeConnections(
  current: PowerConnections,
  additions: readonly PowerConnection[],
): PowerConnections {
  const byId = new Map(current.connections.map((item) => [item.id, item]));
  for (const connection of additions) byId.set(connection.id, connection);
  return powerConnectionsSchema.parse({
    schemaVersion: NOVEL_POWER_SYSTEM_SCHEMA_VERSION,
    connections: [...byId.values()],
  });
}

export async function materializePowerDraftChanges(
  workspace: string,
  draft: PowerSystemDraft,
): Promise<{ changes: PowerDraftChange[]; contentHash: string }> {
  const indexPath = `${POWER_ROOT}/index.json`;
  const catalogPath = `${POWER_ROOT}/catalog.json`;
  const connectionsPath = `${POWER_ROOT}/connections.json`;
  const [index, catalog, connections] = await Promise.all([
    readParsed(projectPath(workspace, indexPath), powerSystemIndexSchema),
    readParsed(projectPath(workspace, catalogPath), powerCatalogSchema),
    readParsed(projectPath(workspace, connectionsPath), powerConnectionsSchema),
  ]);
  const existingEntry = index.systems.find(
    (entry) => entry.id === draft.systemId,
  );
  if (draft.operation === "create" && existingEntry) {
    throw new Error(`力量体系已经存在，不能按新增草稿提交：${draft.systemId}`);
  }
  if (draft.operation === "modify" && !existingEntry) {
    throw new Error(`待修改的力量体系已经不存在：${draft.systemId}`);
  }
  const record = powerSystemRecordSchema.parse({
    ...draft.record,
    updatedAt: draft.updatedAt,
  });
  const entry = {
    id: record.id,
    name: record.name,
    typeId: record.typeId,
    status: record.status,
    summary: record.summary,
    recordPath: `${POWER_ROOT}/records/${record.id}.json`,
    pagePath: `${POWER_ROOT}/pages/${record.id}.md`,
    updatedAt: record.updatedAt,
  };
  const nextIndex: PowerSystemIndex = powerSystemIndexSchema.parse({
    ...index,
    systems: existingEntry
      ? index.systems.map((item) => (item.id === entry.id ? entry : item))
      : [...index.systems, entry],
  });
  const changes: PowerDraftChange[] = [
    {
      id: `index-${record.id}`,
      targetPath: indexPath,
      operation: "modify",
      summary: `登记力量体系“${record.name}”`,
      content: serializeJson(nextIndex),
    },
  ];
  if (draft.catalogEntities.length > 0) {
    changes.push({
      id: `catalog-${record.id}`,
      targetPath: catalogPath,
      operation: "modify",
      summary: `更新“${record.name}”使用的共享力量目录`,
      content: serializeJson(mergeCatalog(catalog, draft.catalogEntities)),
    });
  }
  if (draft.connections.length > 0) {
    changes.push({
      id: `connections-${record.id}`,
      targetPath: connectionsPath,
      operation: "modify",
      summary: `更新“${record.name}”的力量生态连接`,
      content: serializeJson(mergeConnections(connections, draft.connections)),
    });
  }
  changes.push(
    {
      id: `record-${record.id}`,
      targetPath: entry.recordPath,
      operation: draft.operation,
      summary: `${draft.operation === "create" ? "创建" : "更新"}“${record.name}”结构化记录`,
      content: serializeJson(record),
    },
    {
      id: `page-${record.id}`,
      targetPath: entry.pagePath,
      operation: draft.operation,
      summary: `${draft.operation === "create" ? "创建" : "更新"}“${record.name}”说明页`,
      content: draft.pageMarkdown.endsWith("\n")
        ? draft.pageMarkdown
        : `${draft.pageMarkdown}\n`,
    },
  );
  const contentHash = createHash("sha256")
    .update(JSON.stringify(changes))
    .digest("hex");
  return { changes, contentHash };
}

export async function savePowerDraftValidation(
  workspace: string,
  draft: PowerSystemDraft,
  contentHash: string,
): Promise<PowerSystemDraft> {
  return withPowerDraftLock(workspace, draft.draftId, async () => {
    const current = await loadPowerDraft(workspace, draft.draftId);
    if (
      current.revision !== draft.revision ||
      current.updatedAt !== draft.updatedAt ||
      current.submittedProposalId
    ) {
      throw new Error("草稿在校验期间发生变化，请重新校验");
    }
    const validated: PowerSystemDraft = parseDraft({
      ...current,
      validation: {
        token: `validation-${randomUUID()}`,
        contentHash,
        revision: current.revision,
        validatedAt: new Date().toISOString(),
      },
    });
    await writeDraft(workspace, validated);
    return validated;
  });
}

export async function markPowerDraftSubmitted(
  workspace: string,
  draft: PowerSystemDraft,
  proposalId: string,
): Promise<PowerSystemDraft> {
  return withPowerDraftLock(workspace, draft.draftId, async () => {
    const current = await loadPowerDraft(workspace, draft.draftId);
    if (current.submittedProposalId === proposalId) return current;
    if (
      current.revision !== draft.revision ||
      current.validation?.token !== draft.validation?.token ||
      current.submittedProposalId
    ) {
      throw new Error("草稿在提交期间发生变化，请重新读取提案状态");
    }
    const submitted = parseDraft({
      ...current,
      submittedProposalId: proposalId,
      updatedAt: new Date().toISOString(),
    });
    await writeDraft(workspace, submitted);
    return submitted;
  });
}

export async function getPowerProposalStatus(
  workspace: string,
  proposalId: string,
): Promise<{
  exists: boolean;
  proposalId: string;
  status?: "pending" | "partially-applied" | "applied" | "rejected";
  changeCount?: number;
  pendingCount?: number;
  appliedCount?: number;
  rejectedCount?: number;
}> {
  assertId(proposalId, "proposalId");
  const path = projectPath(
    workspace,
    `${POWER_ROOT}/proposals/${proposalId}/proposal.json`,
  );
  const content = await readOptional(path);
  if (content === null) return { exists: false, proposalId };
  const manifest = JSON.parse(content) as {
    proposalId?: unknown;
    changes?: Array<{ status?: unknown }>;
  };
  const statuses = (manifest.changes ?? []).map((change) => change.status);
  const appliedCount = statuses.filter((status) => status === "applied").length;
  const rejectedCount = statuses.filter(
    (status) => status === "rejected",
  ).length;
  const pendingCount = statuses.length - appliedCount - rejectedCount;
  const status =
    statuses.length > 0 && appliedCount === statuses.length
      ? "applied"
      : statuses.length > 0 && rejectedCount === statuses.length
        ? "rejected"
        : appliedCount > 0
          ? "partially-applied"
          : "pending";
  return {
    exists: true,
    proposalId,
    status,
    changeCount: statuses.length,
    pendingCount,
    appliedCount,
    rejectedCount,
  };
}

export function summarizePowerDraft(draft: PowerSystemDraft) {
  return {
    draftId: draft.draftId,
    systemId: draft.systemId,
    operation: draft.operation,
    revision: draft.revision,
    name: draft.record.name,
    typeId: draft.record.typeId,
    status: draft.record.status,
    designBrief: draft.designBrief,
    trackCount: draft.record.tracks.length,
    stateCount: draft.record.tracks.reduce(
      (total, track) => total + track.states.length,
      0,
    ),
    transitionCount: draft.record.tracks.reduce(
      (total, track) => total + track.transitions.length,
      0,
    ),
    dimensionCount: draft.record.dimensions.length,
    catalogEntityCount: draft.catalogEntities.length,
    connectionCount: draft.connections.length,
    validated:
      draft.validation?.revision === draft.revision
        ? {
            token: draft.validation.token,
            validatedAt: draft.validation.validatedAt,
          }
        : null,
    submittedProposalId: draft.submittedProposalId,
    updatedAt: draft.updatedAt,
  };
}
