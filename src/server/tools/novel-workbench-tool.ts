import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import { dirname, join, resolve, sep } from "path";

import {
  characterGroupDefinitionSchema,
  characterRecordSchema,
  characterSoulDefinitionSchema,
  raceDefinitionSchema,
} from "../../shared/workbenches/novel/characterLibrarySchema";
import {
  loadCharacterSoulFiles,
  serializeCharacterSoulSnapshot,
} from "../../shared/workbenches/novel/characterSoulStorage";
import {
  cultivationEcologySchema,
  type CultivationEcology,
  type CultivationSystem,
} from "../../shared/workbenches/novel/cultivationEcologySchema";
import {
  CULTIVATION_ECOLOGY_INDEX_PATH,
  createCultivationEcologyFiles,
  cultivationFileMap,
  loadCultivationEcologyFiles,
  serializeCultivationFileSnapshot,
  type LoadedCultivationEcologyFiles,
} from "../../shared/workbenches/novel/cultivationEcologyStorage";
import { validateCultivationEcology } from "../../shared/workbenches/novel/cultivationEcologyValidation";
import {
  FACTION_INDEX_PATH as FACTION_LIBRARY_PATH,
  loadFactionFiles,
  serializeFactionFileSnapshot,
} from "../../shared/workbenches/novel/factionStorage";
import {
  LOCATION_INDEX_PATH as LOCATION_LIBRARY_PATH,
  loadLocationFiles,
  serializeLocationFileSnapshot,
} from "../../shared/workbenches/novel/locationStorage";
import {
  INSPIRATION_INDEX_PATH,
  inspirationRecordPath,
  loadInspirationFiles,
  serializeInspirationFileSnapshot,
} from "../../shared/workbenches/novel/inspirationStorage";
import {
  manuscriptProposalSchema,
  serializeManuscriptProposal,
  type ManuscriptProposal,
  type ManuscriptWritingMode,
} from "../../shared/workbenches/novel/manuscriptProposalSchema";
import {
  MANUSCRIPT_TRACKING_INDEX_PATH,
  loadManuscriptTrackingFiles,
  manuscriptTrackingBatchPath,
  serializeManuscriptTrackingFileSnapshot,
} from "../../shared/workbenches/novel/manuscriptTrackingStorage";
import {
  MANUSCRIPT_CONTINUITY_INDEX_PATH,
  MANUSCRIPT_CONTINUITY_LEGACY_PATH,
  loadManuscriptContinuityFiles,
  serializeManuscriptContinuityFileSnapshot,
} from "../../shared/workbenches/novel/manuscriptContinuityStorage";
import {
  NARRATIVE_ENGINEERING_INDEX_PATH,
  NARRATIVE_ENGINEERING_SCHEMA_VERSION,
  loadNarrativeEngineeringFiles,
  serializeNarrativeFileSnapshot,
} from "../../shared/workbenches/novel/narrativeEngineeringStorage";
import {
  TIMELINE_INDEX_PATH as TIMELINE_LIBRARY_PATH,
  loadTimelineFiles,
  serializeTimelineFileSnapshot,
} from "../../shared/workbenches/novel/timelineStorage";
import {
  generateFantasyMapCandidate,
  type FantasyFeature,
} from "../../shared/workbenches/novel/fantasyMapGenerator";
import {
  convertAzgaarExportToFeatures,
  selectAzgaarMapDocumentFeatures,
  type AzgaarMapFeature,
} from "../../shared/workbenches/novel/azgaarExportAdapter";
import {
  azgaarRuntimeConfigured,
  createAzgaarRuntimeClient,
} from "../maps/azgaar-runtime";
import { retrieveKnowledgeDocuments } from "../knowledge-retriever";
import {
  bindNovelWorkbenchRuntime,
  getNovelWorkbenchContext,
  NOVEL_WORKBENCH_SDK_ADAPTER_ID,
  NOVEL_WORKBENCH_SDK_INSTRUCTIONS,
  type NovelWorkbenchMode,
} from "../novel-workbench-context";
import {
  createNovelWorkbenchDraft,
  hashNovelWorkbenchDraftPayload,
  loadNovelWorkbenchDraft,
  markNovelWorkbenchDraftSubmitted,
  saveNovelWorkbenchDraftValidation,
  summarizeNovelWorkbenchDraft,
  type NovelWorkbenchDraft,
  updateNovelWorkbenchDraft,
} from "../novel-workbench-draft";

type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ProposedChange = {
  id: string;
  targetPath: string;
  operation: "create" | "modify";
  summary: string;
  content: string;
};

type WorldDraftPatchOperation =
  | {
      targetPath: string;
      action: "merge";
      targetId: string;
      fields: Record<string, unknown>;
      summary?: string;
    }
  | {
      targetPath: string;
      action: "append";
      collection: string;
      parentId?: string;
      value: unknown;
      initial?: Record<string, unknown>;
      summary?: string;
    }
  | {
      targetPath: string;
      action: "remove";
      targetId: string;
      summary?: string;
    }
  | {
      targetPath: string;
      action: "text_append";
      content: string;
      summary?: string;
    };

type ItemFieldValue = string | number | boolean | string[] | null;

type ItemBatchCandidate = {
  name: string;
  aliases?: string[];
  tags?: string[];
  summary?: string;
  values?: Record<string, ItemFieldValue>;
  description?: string;
  appendDescription?: boolean;
};

type ItemCategoryField = {
  id: string;
  ownerCategoryId: string;
  label: string;
  description: string;
  group: string;
  type: string;
  required: boolean;
  defaultValue: ItemFieldValue;
  options: string[];
  unit: string | null;
  entityTypes: string[];
  order: number;
};

const LIBRARY_ROOT = "world/setting-library";
const PROPOSAL_ROOT = `${LIBRARY_ROOT}/proposals`;
const LOCATION_SNAPSHOT_PATH = "__locations/index.json";
const TARGET_PATTERN =
  /^(?:world\/setting-library\/(?:meta\.json|spatial-tree\.json|settings\.json|pages\/[a-z0-9-]+\/[a-z0-9-]+\.md|entries\/[a-z0-9-]+\/[a-z0-9-]+\.json)|world\/locations\/index\.json)$/;
/**
 * settings.json 中 pagePath / entriesPath 的分向约束。
 *
 * `TARGET_PATTERN` 是「允许被提案修改的目标文件」白名单，它是 pages 与 entries
 * 的并集，还额外包含 meta / spatial-tree / settings / locations。用它校验
 * pagePath / entriesPath 会放过 kind 混淆（例如 entriesPath 填了 pages 的 .md，
 * 或直接填 settings.json），这些内容能通过服务端 validate 却过不了 renderer 的
 * `settingFilePath()`，导致作者点“应用选中”时才报“非法entries文件路径”。
 * 两条正则与 `settingLibrarySchema.ts::settingFilePath()` 保持一致。
 */
const SETTING_FILE_PATTERNS = {
  pagePath: /^world\/setting-library\/pages\/[a-z0-9-]+\/[a-z0-9-]+\.md$/,
  entriesPath:
    /^world\/setting-library\/entries\/[a-z0-9-]+\/[a-z0-9-]+\.json$/,
} as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SETTING_STATUS_VALUES = new Set(["draft", "completed"]);
const SETTING_LIBRARY_SOURCE_VALUES = new Set(["builtin", "project"]);
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_CHANGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const ITEM_LIBRARY_ROOT = "world/items";
const ITEM_PROPOSAL_ROOT = `${ITEM_LIBRARY_ROOT}/proposals`;
const MAX_BATCH_ITEMS = 20;
const MAX_ITEM_DESCRIPTION_BYTES = 512 * 1024;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const CHARACTER_LIBRARY_ROOT = "characters";
const CHARACTER_PROPOSAL_ROOT = `${CHARACTER_LIBRARY_ROOT}/proposals`;
const CULTIVATION_PROPOSAL_ROOT = "world/cultivation-proposals";
const MAX_CULTIVATION_CONTEXT_BYTES = 1_000_000;
const MAX_CHARACTER_OPERATIONS = 40;
const MAX_INCREMENTAL_OPERATIONS = 32;
const MAX_INCREMENTAL_BATCH_BYTES = 64 * 1024;
const MAX_MAP_PROPOSAL_BYTES = 24 * 1024 * 1024;
const NARRATIVE_PROPOSAL_ROOT = "narrative/proposals";
const MAX_NARRATIVE_CANDIDATES = 30;
const NARRATIVE_ENGINEERING_PATH = NARRATIVE_ENGINEERING_INDEX_PATH;
const NARRATIVE_PROPOSAL_SCHEMA_VERSION = 4;
const MANUSCRIPT_INDEX_PATH = "manuscript/index.json";
const MANUSCRIPT_PROPOSAL_ROOT = "manuscript/proposals";
const MAX_MANUSCRIPT_CONTENT_BYTES = 4 * 1024 * 1024;
const NARRATIVE_LINE_COLORS = {
  main: "#b64a3a",
  emotion: "#c3812f",
  mirror: "#46766b",
  information: "#486c9c",
  theme: "#765b91",
  custom: "#687078",
} as const;

type NarrativeLineKind = keyof typeof NARRATIVE_LINE_COLORS;
type NarrativeStoryRole = "a" | "b" | "both" | "none";
type NarrativeLineStatus = "idea" | "active" | "resolved" | "paused";
type NarrativeArcKind =
  | "plot"
  | "character"
  | "relationship"
  | "mystery"
  | "theme"
  | "custom";
type NarrativeDirectoryKind = "volume" | "part" | "group";
type NarrativeDirectoryStatus = "idea" | "planned" | "drafting" | "complete";

type NarrativeLineInput = {
  candidateId: string;
  /** Existing line ID when this candidate revises a line instead of creating one. */
  targetId?: string;
  title: string;
  kind?: NarrativeLineKind;
  storyRole?: NarrativeStoryRole;
  status?: NarrativeLineStatus;
  premise?: string;
  content?: string;
  appendContent?: boolean;
  protagonistCharacterId?: string | null;
  keyNodes: NarrativeKeyNodeInput[];
};

type NarrativeStoryArcInput = {
  candidateId: string;
  /** Existing story arc ID when this candidate revises an arc instead of creating one. */
  targetId?: string;
  title: string;
  kind?: NarrativeArcKind;
  characterId?: string | null;
  characterArcStageId?: string | null;
  characterArcStageTitle?: string;
  lineIds?: string[];
  content?: string;
  appendContent?: boolean;
  keyNodes: NarrativeKeyNodeInput[];
};

type NarrativeDirectoryInput = {
  candidateId: string;
  /** Existing directory ID when this candidate revises a directory. */
  targetId?: string;
  /** Another candidateId in this draft, an existing directory ID, or null. */
  parentId: string | null;
  kind: NarrativeDirectoryKind;
  title: string;
  description?: string;
  status?: NarrativeDirectoryStatus;
  order: number;
};

type NarrativeParagraphInput = {
  candidateId: string;
  /** Existing paragraph ID when preserving or revising a paragraph. */
  targetId?: string;
  order: number;
  content: string;
  appendContent?: boolean;
};

type NarrativeSectionInput = {
  candidateId: string;
  /** Existing section ID when preserving or revising a section. */
  targetId?: string;
  order: number;
  title: string;
  description: string;
  povCharacterId?: string | null;
  lineIds?: string[];
  arcIds?: string[];
  paragraphs: NarrativeParagraphInput[];
};

type NarrativeChapterInput = {
  candidateId: string;
  /** Existing chapter ID when this candidate revises a chapter. */
  targetId?: string;
  /** Directory candidate ID, existing directory ID, or null for unassigned. */
  directoryId: string | null;
  title: string;
  description: string;
  status?: NarrativeDirectoryStatus;
  order: number;
  lineIds?: string[];
  arcIds?: string[];
  sections: NarrativeSectionInput[];
};

type NarrativeKeyNodeInput = {
  nodeId: string;
  title: string;
  content: string;
  locations?: { chapterId: string; sectionId: string | null }[];
};

type NarrativeDraftPayload = {
  title: string;
  description: string;
  baseSourceHash: string;
  lines: NarrativeLineInput[];
  arcs: NarrativeStoryArcInput[];
  directories: NarrativeDirectoryInput[];
  chapters: NarrativeChapterInput[];
};

type CharacterProposalOperation = {
  candidateId: string;
  kind: "character" | "race" | "group" | "soul";
  action: "create" | "update";
  targetId?: string;
  baseValue?: Record<string, unknown>;
  summary: string;
  value: Record<string, unknown>;
};

type CultivationDraftPayload = {
  title: string;
  description: string;
  baseSourceHash: string;
  content: string;
};

const MAX_CULTIVATION_PATCH_OPERATIONS = MAX_INCREMENTAL_OPERATIONS;
const MAX_CULTIVATION_PATCH_BYTES = MAX_INCREMENTAL_BATCH_BYTES;

type CultivationDraftPatchOperation =
  | {
      action: "merge";
      targetId: string;
      fields: Record<string, unknown>;
    }
  | {
      action: "append";
      collection: string;
      parentId?: string;
      value: unknown;
    }
  | {
      action: "remove";
      targetId: string;
    };

type ManuscriptDraftPayload = {
  title: string;
  description: string;
  runId: string;
  chapterId: string;
  chapterTitle: string;
  chapterPath: string;
  baseSourceHash: string;
  sourceContent: string;
  mode: ManuscriptWritingMode;
  rangeStart: number;
  rangeEnd: number;
  candidate: { id: string; content: string } | null;
};

function result(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertIncrementalBatch(
  value: readonly unknown[],
  label: string,
  maxItems = MAX_INCREMENTAL_OPERATIONS,
): void {
  if (value.length > maxItems) {
    throw new Error(`${label}单次最多 ${maxItems} 项，请拆成多次增量调用`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_INCREMENTAL_BATCH_BYTES) {
    throw new Error(
      `${label}单次载荷最多 ${MAX_INCREMENTAL_BATCH_BYTES} 字节，请拆成多次增量调用`,
    );
  }
}

function assertMapProposalPayload(
  operations: readonly MapProposalOperation[],
): void {
  if (operations.length > MAX_MAP_OPERATIONS) {
    throw new Error(`地图候选单次最多 ${MAX_MAP_OPERATIONS} 项`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(operations), "utf8");
  if (bytes > MAX_MAP_PROPOSAL_BYTES) {
    throw new Error(
      `地图提案最多 ${MAX_MAP_PROPOSAL_BYTES} 字节，请缩小底图或拆分地图`,
    );
  }
}

function requireWorkspace(): {
  workspace: string;
  context: NonNullable<ReturnType<typeof getNovelWorkbenchContext>>;
} {
  const context = getNovelWorkbenchContext();
  if (!context?.workspace) {
    throw new Error("小说工作台工具尚未绑定到项目工作区");
  }
  return { workspace: resolve(context.workspace), context };
}

function requireWorkbenchMode(
  expected: NovelWorkbenchMode | readonly NovelWorkbenchMode[],
): ReturnType<typeof requireWorkspace> {
  const current = requireWorkspace();
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(current.context.mode)) {
    throw new Error(
      `当前受控会话为 ${current.context.mode} 模式，不能调用此工具`,
    );
  }
  return current;
}

function normalizeTargetPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!TARGET_PATTERN.test(normalized)) {
    throw new Error(`不允许的世界架构或地点目标路径：${value}`);
  }
  return normalized;
}

function proposalSnapshotRelativePath(targetPath: string): string {
  return targetPath === LOCATION_LIBRARY_PATH
    ? LOCATION_SNAPSHOT_PATH
    : targetPath.slice(`${LIBRARY_ROOT}/`.length);
}

function workspaceFile(workspace: string, path: string): string {
  const absolute = resolve(workspace, ...path.split("/"));
  if (absolute !== workspace && !absolute.startsWith(`${workspace}${sep}`)) {
    throw new Error(`路径越出小说项目：${path}`);
  }
  return absolute;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadLocationSource(workspace: string) {
  const index = await readOptional(
    workspaceFile(workspace, LOCATION_LIBRARY_PATH),
  );
  if (index === null) return null;
  const loaded = await loadLocationFiles(async (path) => {
    const content = await readOptional(workspaceFile(workspace, path));
    if (content === null) throw new Error(`地点记录不存在：${path}`);
    return content;
  });
  return {
    ...loaded,
    snapshot: serializeLocationFileSnapshot(loaded.files),
    aggregateContent: `${JSON.stringify(loaded.library, null, 2)}\n`,
  };
}

async function readWorldTarget(
  workspace: string,
  targetPath: string,
): Promise<string | null> {
  if (targetPath !== LOCATION_LIBRARY_PATH) {
    return readOptional(workspaceFile(workspace, targetPath));
  }
  return (await loadLocationSource(workspace))?.aggregateContent ?? null;
}

type LoadedCultivationSource = LoadedCultivationEcologyFiles & {
  readonly snapshot: string;
  readonly aggregateContent: string;
};

async function loadCultivationSource(
  workspace: string,
): Promise<LoadedCultivationSource | null> {
  const index = await readOptional(
    workspaceFile(workspace, CULTIVATION_ECOLOGY_INDEX_PATH),
  );
  if (index === null) return null;
  const loaded = await loadCultivationEcologyFiles(async (path) => {
    const content = await readOptional(workspaceFile(workspace, path));
    if (content === null) throw new Error(`修行生态模块不存在：${path}`);
    return content;
  });
  return {
    ...loaded,
    snapshot: serializeCultivationFileSnapshot(loaded.files),
    aggregateContent: `${JSON.stringify(loaded.ecology, null, 2)}\n`,
  };
}

function parseJson(path: string, content: string, errors: string[]): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    errors.push(`${path} 不是有效 JSON：${message(error)}`);
    return null;
  }
}

function arrayField(value: unknown, field: string): unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[field];
  return Array.isArray(candidate) ? candidate : null;
}

function validateSettingLibraryRecordSources(
  records: readonly unknown[],
  label: "层级类型" | "设定模板",
  errors: string[],
): void {
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const item = record as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "<unknown>";
    if (typeof item.source !== "string") {
      errors.push(`${label} ${id} 缺少 source`);
    } else if (!SETTING_LIBRARY_SOURCE_VALUES.has(item.source)) {
      errors.push(
        `${label} ${id} 的 source 必须为 builtin 或 project，当前为 ${item.source}`,
      );
    }
  }
}

function validateLocationIndex(
  value: unknown,
  nodeIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("地点索引必须是 JSON 对象");
    return;
  }
  const index = value as Record<string, unknown>;
  if (index.schemaVersion !== 1) {
    errors.push("地点索引 schemaVersion 必须为 1");
  }
  const locations = arrayField(index, "locations");
  if (!locations) {
    errors.push("地点索引缺少 locations 数组");
    return;
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const location of locations) {
    if (!location || typeof location !== "object" || Array.isArray(location)) {
      errors.push("地点索引包含非法地点记录");
      continue;
    }
    const item = location as Record<string, unknown>;
    const id = item.id;
    const name = item.name;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || byId.has(id)) {
      errors.push(`地点索引包含非法或重复 id：${String(id)}`);
    } else {
      byId.set(id, item);
    }
    if (typeof name !== "string" || !name.trim()) {
      errors.push(`地点 ${String(id)} 缺少名称`);
    }
    if (typeof item.nodeId !== "string" || !nodeIds.has(item.nodeId)) {
      errors.push(`地点 ${String(id)} 引用了不存在的空间节点`);
    }
    if (
      item.parentLocationId !== null &&
      (typeof item.parentLocationId !== "string" ||
        !ID_PATTERN.test(item.parentLocationId))
    ) {
      errors.push(`地点 ${String(id)} 的上级地点非法`);
    }
    if (
      !Array.isArray(item.aliases) ||
      item.aliases.some((alias) => typeof alias !== "string" || !alias.trim())
    ) {
      errors.push(`地点 ${String(id)} 的别名必须为非空字符串数组`);
    }
    if (typeof item.type !== "string" || !item.type.trim()) {
      errors.push(`地点 ${String(id)} 缺少地点类型`);
    }
    if (
      item.status !== "planned" &&
      item.status !== "appeared" &&
      item.status !== "archived"
    ) {
      errors.push(`地点 ${String(id)} 的出场状态非法`);
    }
    for (const field of ["summary", "appearanceNote", "description"] as const) {
      if (typeof item[field] !== "string") {
        errors.push(`地点 ${String(id)} 的 ${field} 必须为字符串`);
      }
    }
    if (
      typeof item.order !== "number" ||
      !Number.isInteger(item.order) ||
      item.order < 0
    ) {
      errors.push(`地点 ${String(id)} 的排序值非法`);
    }
  }

  for (const [id, location] of byId) {
    const parentId = location.parentLocationId;
    if (parentId === null) continue;
    if (typeof parentId !== "string") continue;
    const parent = byId.get(parentId);
    if (!parent) {
      errors.push(`地点 ${id} 引用了不存在的上级地点：${parentId}`);
      continue;
    }
    if (parent.nodeId !== location.nodeId) {
      errors.push(`地点 ${id} 的上级地点必须属于同一空间节点`);
    }
    const visited = new Set([id]);
    let currentId: string | null = parentId;
    while (currentId) {
      if (visited.has(currentId)) {
        errors.push(`地点层级包含循环引用：${id}`);
        break;
      }
      visited.add(currentId);
      const current = byId.get(currentId);
      currentId =
        current && typeof current.parentLocationId === "string"
          ? current.parentLocationId
          : null;
    }
  }
}

async function validateChanges(
  changes: readonly ProposedChange[],
): Promise<string[]> {
  const { workspace } = requireWorkspace();
  const errors: string[] = [];
  if (changes.length === 0) return ["至少需要一个变更"];
  if (changes.length > 100) return ["单个提案最多包含 100 个变更"];

  const ids = new Set<string>();
  const targets = new Set<string>();
  const prospective = new Map<string, string>();
  let totalBytes = 0;
  for (const change of changes) {
    if (!ID_PATTERN.test(change.id) || ids.has(change.id)) {
      errors.push(`变更 id 非法或重复：${change.id}`);
    }
    ids.add(change.id);
    let targetPath: string;
    try {
      targetPath = normalizeTargetPath(change.targetPath);
    } catch (error) {
      errors.push(message(error));
      continue;
    }
    if (targets.has(targetPath)) errors.push(`目标路径重复：${targetPath}`);
    targets.add(targetPath);
    if (!change.summary.trim()) errors.push(`${change.id} 缺少变更摘要`);
    const bytes = Buffer.byteLength(change.content, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_CHANGE_BYTES) errors.push(`${targetPath} 超过 2 MiB`);
    prospective.set(targetPath, change.content);
    const current = await readWorldTarget(workspace, targetPath);
    if (change.operation === "create" && current !== null) {
      errors.push(`create 目标已经存在：${targetPath}`);
    }
    if (change.operation === "modify" && current === null) {
      errors.push(`modify 目标不存在：${targetPath}`);
    }
    if (targetPath.endsWith(".json"))
      parseJson(targetPath, change.content, errors);
  }
  if (totalBytes > MAX_TOTAL_BYTES) errors.push("提案内容总量超过 8 MiB");
  if (errors.length > 0) return errors;

  const readProspectiveJson = async (path: string): Promise<unknown> => {
    const content =
      prospective.get(path) ??
      (await readOptional(workspaceFile(workspace, path)));
    if (content === null) {
      errors.push(`缺少正式设定文件：${path}`);
      return null;
    }
    return parseJson(path, content, errors);
  };
  const meta = await readProspectiveJson(`${LIBRARY_ROOT}/meta.json`);
  const tree = await readProspectiveJson(`${LIBRARY_ROOT}/spatial-tree.json`);
  const settings = await readProspectiveJson(`${LIBRARY_ROOT}/settings.json`);
  const levelTypes = arrayField(meta, "levelTypes");
  const templates = arrayField(meta, "settingTemplates");
  const profiles = arrayField(meta, "profiles");
  const nodes = arrayField(tree, "nodes");
  const settingItems = arrayField(settings, "settings");
  for (const [path, value] of [
    [`${LIBRARY_ROOT}/meta.json`, meta],
    [`${LIBRARY_ROOT}/spatial-tree.json`, tree],
    [`${LIBRARY_ROOT}/settings.json`, settings],
  ] as const) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).schemaVersion !== 1
    ) {
      errors.push(`${path} 的 schemaVersion 必须为 1`);
    }
  }
  if (!levelTypes) errors.push("meta.json 缺少 levelTypes 数组");
  if (!templates) errors.push("meta.json 缺少 settingTemplates 数组");
  if (!profiles) errors.push("meta.json 缺少 profiles 数组");
  if (!nodes) errors.push("spatial-tree.json 缺少 nodes 数组");
  if (!settingItems) errors.push("settings.json 缺少 settings 数组");
  if (errors.length > 0) return errors;

  const idsOf = (items: unknown[], label: string): Set<string> => {
    const output = new Set<string>();
    for (const item of items) {
      const id =
        item && typeof item === "object"
          ? (item as Record<string, unknown>).id
          : null;
      if (typeof id !== "string" || !ID_PATTERN.test(id) || output.has(id)) {
        errors.push(`${label} 包含非法或重复 id：${String(id)}`);
      } else output.add(id);
    }
    return output;
  };
  const typeIds = idsOf(levelTypes!, "levelTypes");
  const templateIds = idsOf(templates!, "settingTemplates");
  const nodeIds = idsOf(nodes!, "nodes");
  validateSettingLibraryRecordSources(levelTypes!, "层级类型", errors);
  validateSettingLibraryRecordSources(templates!, "设定模板", errors);
  const parentByNode = new Map<string, string | null>();
  for (const node of nodes!) {
    if (!node || typeof node !== "object") continue;
    const item = node as Record<string, unknown>;
    if (typeof item.id === "string") {
      parentByNode.set(
        item.id,
        typeof item.parentId === "string" ? item.parentId : null,
      );
    }
    if (typeof item.typeId !== "string" || !typeIds.has(item.typeId)) {
      errors.push(`空间节点 ${String(item.id)} 引用了不存在的类型`);
    }
    if (
      item.parentId !== null &&
      (typeof item.parentId !== "string" || !nodeIds.has(item.parentId))
    ) {
      errors.push(`空间节点 ${String(item.id)} 引用了不存在的父节点`);
    }
  }
  for (const nodeId of nodeIds) {
    const visited = new Set([nodeId]);
    let parentId = parentByNode.get(nodeId) ?? null;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        errors.push(`空间树包含循环引用：${nodeId}`);
        break;
      }
      visited.add(parentId);
      parentId = parentByNode.get(parentId) ?? null;
    }
  }
  const locationContent =
    prospective.get(LOCATION_LIBRARY_PATH) ??
    (await readWorldTarget(workspace, LOCATION_LIBRARY_PATH));
  if (locationContent !== null) {
    const locations = parseJson(LOCATION_LIBRARY_PATH, locationContent, errors);
    if (locations !== null) validateLocationIndex(locations, nodeIds, errors);
  }
  const profileTypeIds = new Set<string>();
  for (const profile of profiles!) {
    if (!profile || typeof profile !== "object") continue;
    const item = profile as Record<string, unknown>;
    if (
      typeof item.levelTypeId !== "string" ||
      !typeIds.has(item.levelTypeId)
    ) {
      errors.push(
        `模板关联引用了不存在的层级类型：${String(item.levelTypeId)}`,
      );
    }
    if (typeof item.levelTypeId === "string") {
      if (profileTypeIds.has(item.levelTypeId)) {
        errors.push(`层级类型 ${item.levelTypeId} 只能有一份模板关联`);
      }
      profileTypeIds.add(item.levelTypeId);
    }
    if (
      !Array.isArray(item.templateIds) ||
      item.templateIds.some(
        (id) => typeof id !== "string" || !templateIds.has(id),
      )
    ) {
      errors.push(`层级类型 ${String(item.levelTypeId)} 包含不存在的模板引用`);
    } else if (new Set(item.templateIds).size !== item.templateIds.length) {
      errors.push(`层级类型 ${String(item.levelTypeId)} 包含重复的模板引用`);
    }
  }
  const settingIds = new Set<string>();
  const materializedTemplates = new Set<string>();
  const referencedSettingFiles = new Set<string>();
  for (const [settingIndex, setting] of settingItems!.entries()) {
    if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
      errors.push(`settings 第 ${settingIndex + 1} 个条目必须是对象`);
      continue;
    }
    const item = setting as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !ID_PATTERN.test(item.id) ||
      settingIds.has(item.id)
    ) {
      errors.push(`settings 包含非法或重复 id：${String(item.id)}`);
    } else {
      settingIds.add(item.id);
    }
    if (typeof item.nodeId !== "string" || !nodeIds.has(item.nodeId)) {
      errors.push(`设定 ${String(item.id)} 引用了不存在的空间节点`);
    }
    if (!("templateId" in item)) {
      errors.push(`设定 ${String(item.id)} 缺少 templateId`);
    } else if (
      item.templateId !== null &&
      (typeof item.templateId !== "string" || !templateIds.has(item.templateId))
    ) {
      errors.push(`设定 ${String(item.id)} 引用了不存在的模板`);
    }
    if (
      typeof item.nodeId === "string" &&
      typeof item.templateId === "string"
    ) {
      const identity = `${item.nodeId}:${item.templateId}`;
      if (materializedTemplates.has(identity)) {
        errors.push(
          `设定 ${String(item.id)} 与同节点的其他页面重复使用模板 ${item.templateId}`,
        );
      }
      materializedTemplates.add(identity);
    }
    // 这三个字段是 renderer `settingInstanceSchema` 的必填项。工具侧过去只校验
    // id / nodeId / templateId / 路径，缺字段的提案能拿到 validationToken 并提交，
    // 直到作者点“应用选中”时才由 zod 报错。在这里同步校验，保证受控写回协议的
    // 校验强度不弱于落盘契约。
    for (const key of ["name", "group"] as const) {
      if (typeof item[key] !== "string" || item[key].trim() === "") {
        errors.push(`设定 ${String(item.id)} 缺少 ${key}`);
      }
    }
    if (
      typeof item.status !== "string" ||
      !SETTING_STATUS_VALUES.has(item.status)
    ) {
      errors.push(
        `设定 ${String(item.id)} 的 status 必须是 draft 或 completed，当前为 ${String(item.status)}`,
      );
    }
    if (
      item.templateVersion !== undefined &&
      (typeof item.templateVersion !== "string" ||
        !SEMVER_PATTERN.test(item.templateVersion))
    ) {
      errors.push(
        `设定 ${String(item.id)} 的 templateVersion 必须是 x.y.z 形式`,
      );
    }
    for (const key of ["pagePath", "entriesPath"] as const) {
      if (typeof item[key] !== "string") {
        errors.push(`设定 ${String(item.id)} 缺少 ${key}`);
        continue;
      }
      let path: string;
      try {
        path = normalizeTargetPath(item[key]);
      } catch (error) {
        errors.push(message(error));
        continue;
      }
      // 分向校验：pagePath 必须落在 pages/ 且以 .md 结尾，entriesPath 必须落在
      // entries/ 且以 .json 结尾。normalizeTargetPath 只保证「在提案可改白名单
      // 内」，不区分 kind。
      if (!SETTING_FILE_PATTERNS[key].test(path)) {
        errors.push(
          `设定 ${String(item.id)} 的 ${key} 必须形如 ${
            key === "pagePath"
              ? `${LIBRARY_ROOT}/pages/<nodeId>/<settingId>.md`
              : `${LIBRARY_ROOT}/entries/<nodeId>/<settingId>.json`
          }，当前为 ${path}`,
        );
        continue;
      }
      if (
        typeof item.nodeId === "string" &&
        ID_PATTERN.test(item.nodeId) &&
        typeof item.id === "string" &&
        ID_PATTERN.test(item.id)
      ) {
        const expectedPath =
          key === "pagePath"
            ? `${LIBRARY_ROOT}/pages/${item.nodeId}/${item.id}.md`
            : `${LIBRARY_ROOT}/entries/${item.nodeId}/${item.id}.json`;
        if (path !== expectedPath) {
          errors.push(
            `设定 ${item.id} 的 ${key} 必须与自身 nodeId/id 对应，期望 ${expectedPath}，当前为 ${path}`,
          );
          continue;
        }
      }
      referencedSettingFiles.add(path);
      if (
        !prospective.has(path) &&
        (await readOptional(workspaceFile(workspace, path))) === null
      ) {
        errors.push(`设定 ${String(item.id)} 引用了不存在的文件：${path}`);
      }
    }
  }
  const orphanProposalFiles = [...prospective.keys()].filter(
    (path) =>
      (path.startsWith(`${LIBRARY_ROOT}/pages/`) ||
        path.startsWith(`${LIBRARY_ROOT}/entries/`)) &&
      !referencedSettingFiles.has(path),
  );
  if (orphanProposalFiles.length > 0) {
    const preview = orphanProposalFiles.slice(0, 3).join("、");
    const remainder =
      orphanProposalFiles.length - Math.min(3, orphanProposalFiles.length);
    errors.push(
      `提案文件未被最终 settings.json 引用：${preview}${
        remainder > 0 ? `（另有 ${remainder} 个）` : ""
      }。请在同一提案中修改 settings.json，登记对应的 pagePath 和 entriesPath`,
    );
  }
  return errors;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

async function readItemLibraryState(workspace: string) {
  const [metaContent, indexContent, novelContent] = await Promise.all([
    readOptional(workspaceFile(workspace, `${ITEM_LIBRARY_ROOT}/meta.json`)),
    readOptional(workspaceFile(workspace, `${ITEM_LIBRARY_ROOT}/index.json`)),
    readOptional(workspaceFile(workspace, "novel.json")),
  ]);
  if (metaContent === null || indexContent === null) {
    throw new Error("物品库尚未初始化，请先在小说工作台打开物品库");
  }
  const meta = objectValue(JSON.parse(metaContent), "物品分类配置");
  const index = objectValue(JSON.parse(indexContent), "物品索引");
  const categories = Array.isArray(meta.categories) ? meta.categories : null;
  const fields = Array.isArray(meta.fields) ? meta.fields : null;
  const items = Array.isArray(index.items) ? index.items : null;
  if (!categories || !fields || !items) {
    throw new Error("物品库 meta.json 或 index.json 缺少必要数组");
  }
  const novel = novelContent
    ? objectValue(JSON.parse(novelContent), "小说项目配置")
    : {};
  return { meta, index, categories, fields, items, novel };
}

function effectiveItemFields(
  state: Awaited<ReturnType<typeof readItemLibraryState>>,
  categoryId: string,
): { category: Record<string, unknown>; fields: ItemCategoryField[] } {
  const categories = state.categories.map((value, index) =>
    objectValue(value, `物品分类 ${index + 1}`),
  );
  const category = categories.find((item) => item.id === categoryId);
  if (!category) throw new Error(`物品分类不存在：${categoryId}`);
  if (category.archived === true)
    throw new Error("不能向已归档分类批量生产物品");

  const ancestorIds = new Set<string>();
  let current: Record<string, unknown> | undefined = category;
  while (
    current &&
    typeof current.id === "string" &&
    !ancestorIds.has(current.id)
  ) {
    ancestorIds.add(current.id);
    current =
      typeof current.parentId === "string"
        ? categories.find((item) => item.id === current?.parentId)
        : undefined;
  }
  const fields = state.fields
    .map((value, index) => objectValue(value, `物品字段 ${index + 1}`))
    .filter(
      (field) =>
        typeof field.ownerCategoryId === "string" &&
        ancestorIds.has(field.ownerCategoryId) &&
        field.archived !== true,
    )
    .map((field) => {
      if (
        typeof field.id !== "string" ||
        typeof field.label !== "string" ||
        typeof field.type !== "string" ||
        typeof field.required !== "boolean" ||
        !Array.isArray(field.options)
      ) {
        throw new Error("物品分类字段定义不完整");
      }
      return {
        id: field.id,
        ownerCategoryId: String(field.ownerCategoryId),
        label: field.label,
        description:
          typeof field.description === "string" ? field.description : "",
        group: typeof field.group === "string" ? field.group : "",
        type: field.type,
        required: field.required,
        defaultValue: field.defaultValue as ItemFieldValue,
        options: field.options.filter(
          (value): value is string => typeof value === "string",
        ),
        unit: typeof field.unit === "string" ? field.unit : null,
        entityTypes: Array.isArray(field.entityTypes)
          ? field.entityTypes.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        order: typeof field.order === "number" ? field.order : 0,
      };
    })
    .sort((left, right) => left.order - right.order);
  return { category, fields };
}

function itemValueIsPresent(value: ItemFieldValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "boolean" || Number.isFinite(value);
}

function validateItemFieldValue(
  field: ItemCategoryField,
  value: ItemFieldValue,
): string | null {
  if (value === null) return null;
  if (field.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : `字段“${field.label}”必须是有效数字`;
  }
  if (field.type === "boolean") {
    return typeof value === "boolean"
      ? null
      : `字段“${field.label}”必须是开关值`;
  }
  if (field.type === "multi-select") {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      return `字段“${field.label}”必须是字符串数组`;
    }
    const invalid = value.find(
      (item) => field.options.length > 0 && !field.options.includes(item),
    );
    return invalid ? `字段“${field.label}”包含非法选项：${invalid}` : null;
  }
  if (typeof value !== "string") return `字段“${field.label}”必须是文本`;
  if (
    field.type === "single-select" &&
    field.options.length > 0 &&
    !field.options.includes(value)
  ) {
    return `字段“${field.label}”包含非法选项：${value}`;
  }
  return null;
}

async function validateItemBatch(
  categoryId: string,
  candidates: readonly ItemBatchCandidate[],
): Promise<string[]> {
  const { workspace, context } = requireWorkspace();
  if (context.mode !== "items") return ["当前受控会话不是物品库批量生产会话"];
  const errors: string[] = [];
  if (candidates.length === 0) return ["至少需要一件物品候选"];
  if (candidates.length > MAX_BATCH_ITEMS) {
    return [`单份物品提案最多包含 ${MAX_BATCH_ITEMS} 件候选`];
  }
  const state = await readItemLibraryState(workspace);
  let fields: ItemCategoryField[];
  try {
    fields = effectiveItemFields(state, categoryId).fields;
  } catch (error) {
    return [message(error)];
  }
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const names = new Set(
    state.items
      .map((value) => objectValue(value, "物品索引项").name)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLocaleLowerCase("zh-CN")),
  );
  let totalBytes = 0;
  candidates.forEach((candidate, index) => {
    const position = `第 ${index + 1} 件物品`;
    const name = candidate.name.trim();
    if (!name) errors.push(`${position}缺少名称`);
    if (name.length > 120) errors.push(`${position}名称超过 120 个字符`);
    const normalizedName = name.toLocaleLowerCase("zh-CN");
    if (normalizedName && names.has(normalizedName)) {
      errors.push(`物品名称重复：${name}`);
    }
    if (normalizedName) names.add(normalizedName);
    if ((candidate.summary ?? "").trim().length > 500) {
      errors.push(`${position}摘要超过 500 个字符`);
    }
    for (const [label, values] of [
      ["别名", candidate.aliases ?? []],
      ["标签", candidate.tags ?? []],
    ] as const) {
      if (values.some((value) => !value.trim() || value.length > 80)) {
        errors.push(`${position}${label}包含空值或超过 80 个字符的值`);
      }
    }
    const candidateValues = candidate.values ?? {};
    for (const [fieldId, value] of Object.entries(candidateValues)) {
      const field = fieldsById.get(fieldId);
      if (!field) {
        errors.push(`${position}使用了当前分类不允许的字段：${fieldId}`);
        continue;
      }
      const fieldError = validateItemFieldValue(field, value);
      if (fieldError) errors.push(`${position}${fieldError}`);
    }
    for (const field of fields) {
      const value = candidateValues[field.id] ?? field.defaultValue;
      if (field.required && !itemValueIsPresent(value)) {
        errors.push(`${position}缺少必填字段“${field.label}”`);
      }
    }
    const descriptionBytes = Buffer.byteLength(
      candidate.description ?? "",
      "utf8",
    );
    totalBytes += descriptionBytes;
    if (descriptionBytes > MAX_ITEM_DESCRIPTION_BYTES) {
      errors.push(`${position}描述超过 512 KiB`);
    }
  });
  if (totalBytes > MAX_BATCH_BYTES) errors.push("物品提案描述总量超过 4 MiB");
  return errors;
}

async function getItemContextHandler(args: {
  categoryId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const state = await readItemLibraryState(workspace);
    const categories = state.categories.map((value) => {
      const category = objectValue(value, "物品分类");
      return {
        id: category.id,
        parentId: category.parentId,
        name: category.name,
        description: category.description,
        archived: category.archived === true,
      };
    });
    const selected = args.categoryId
      ? effectiveItemFields(state, args.categoryId)
      : null;
    return result({
      project: {
        title: state.novel.title ?? state.novel.name ?? "",
        genres: state.novel.genres ?? [],
      },
      categories,
      selectedCategory: selected?.category ?? null,
      fields: selected?.fields ?? [],
      existingItems: state.items.slice(0, 300).map((value) => {
        const item = objectValue(value, "物品索引项");
        return {
          name: item.name,
          categoryId: item.categoryId,
          summary: item.summary,
          tags: item.tags,
        };
      }),
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateItemBatchHandler(args: {
  categoryId: string;
  items: ItemBatchCandidate[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.items, "物品候选", MAX_BATCH_ITEMS);
    const errors = await validateItemBatch(args.categoryId, args.items);
    return result({ valid: errors.length === 0, errors }, errors.length > 0);
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitItemBatchHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  categoryId: string;
  items: ItemBatchCandidate[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    assertIncrementalBatch(args.items, "物品候选", MAX_BATCH_ITEMS);
    const { workspace, context } = requireWorkspace();
    const errors = await validateItemBatch(args.categoryId, args.items);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const proposalId =
      args.proposalId?.trim() || `item-proposal-${randomUUID().slice(0, 8)}`;
    if (!ID_PATTERN.test(proposalId)) {
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    }
    const proposalsDirectory = workspaceFile(workspace, ITEM_PROPOSAL_ROOT);
    proposalDirectory = workspaceFile(
      workspace,
      `${ITEM_PROPOSAL_ROOT}/${proposalId}`,
    );
    if (await readOptional(join(proposalDirectory, "proposal.json"))) {
      return result({
        submitted: true,
        proposalId,
        recovered: true,
        reviewAction: "请作者在小说工作台的物品库中审阅并选择创建候选。",
      });
    }
    await fs.mkdir(proposalsDirectory, { recursive: true });
    await fs.mkdir(proposalDirectory);
    createdProposalDirectory = true;
    const manifest = {
      schemaVersion: 1,
      proposalId,
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      categoryId: args.categoryId,
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent",
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      items: args.items.map((item) => ({
        candidateId: `candidate-${randomUUID().slice(0, 8)}`,
        name: item.name.trim(),
        aliases: [
          ...new Set((item.aliases ?? []).map((value) => value.trim())),
        ],
        tags: [...new Set((item.tags ?? []).map((value) => value.trim()))],
        summary: item.summary?.trim() ?? "",
        values: item.values ?? {},
        description: item.description?.trim() || `# ${item.name.trim()}\n`,
        status: "pending",
      })),
    };
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return result({
      submitted: true,
      proposalId,
      itemCount: manifest.items.length,
      reviewAction: "请作者在小说工作台的物品库中审阅并选择创建候选。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function readCharacterLibraryState(workspace: string) {
  const [
    metaContent,
    indexContent,
    itemIndexContent,
    novelContent,
    soulSource,
  ] = await Promise.all([
    readOptional(
      workspaceFile(workspace, `${CHARACTER_LIBRARY_ROOT}/library.json`),
    ),
    readOptional(
      workspaceFile(workspace, `${CHARACTER_LIBRARY_ROOT}/index.json`),
    ),
    readOptional(workspaceFile(workspace, `${ITEM_LIBRARY_ROOT}/index.json`)),
    readOptional(workspaceFile(workspace, "novel.json")),
    loadCharacterSoulFiles((path) =>
      fs.readFile(workspaceFile(workspace, path), "utf8"),
    ),
  ]);
  if (metaContent === null || indexContent === null) {
    throw new Error("人物库尚未初始化，请先在小说工作台打开人物库");
  }
  const meta = objectValue(JSON.parse(metaContent), "人物库配置");
  const index = objectValue(JSON.parse(indexContent), "人物库索引");
  const races = arrayField(meta, "races");
  const groups = arrayField(meta, "groups");
  const souls = soulSource.souls;
  const characters = arrayField(index, "characters");
  if (!races || !groups || !characters) {
    throw new Error("人物库配置或索引缺少必要数组");
  }
  const novel = novelContent
    ? objectValue(JSON.parse(novelContent), "小说项目配置")
    : {};
  const itemIndex = itemIndexContent
    ? objectValue(JSON.parse(itemIndexContent), "物品库索引")
    : {};
  const items = arrayField(itemIndex, "items") ?? [];
  const sourceSnapshot = JSON.stringify({
    meta: metaContent,
    index: indexContent,
    souls: serializeCharacterSoulSnapshot(soulSource.files),
  });
  return {
    meta,
    index,
    races,
    groups,
    souls,
    characters,
    items,
    novel,
    sourceSnapshot,
  };
}

function operationId(
  value: Record<string, unknown>,
  operation: CharacterProposalOperation,
): string {
  const id = operation.action === "update" ? operation.targetId : value.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(`${operation.kind}候选缺少合法 id`);
  }
  return id;
}

function validateCharacterDefinition(
  kind: CharacterProposalOperation["kind"],
  value: Record<string, unknown>,
  errors: string[],
): void {
  const schema =
    kind === "character"
      ? characterRecordSchema
      : kind === "race"
        ? raceDefinitionSchema
        : kind === "group"
          ? characterGroupDefinitionSchema
          : characterSoulDefinitionSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const label =
      kind === "character"
        ? "角色"
        : kind === "race"
          ? "种族"
          : kind === "group"
            ? "角色分组"
            : "角色灵魂";
    errors.push(
      `${label}候选格式错误：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
}

async function validateCharacterProposal(
  operations: readonly CharacterProposalOperation[],
): Promise<string[]> {
  const { workspace, context } = requireWorkspace();
  if (context.mode !== "characters") {
    return ["当前受控会话不是人物库设计会话"];
  }
  const errors: string[] = [];
  if (operations.length === 0) return ["至少需要一个人物库候选"];
  if (operations.length > MAX_CHARACTER_OPERATIONS) {
    return [`单份角色提案最多包含 ${MAX_CHARACTER_OPERATIONS} 项候选`];
  }
  let state: Awaited<ReturnType<typeof readCharacterLibraryState>>;
  try {
    state = await readCharacterLibraryState(workspace);
  } catch (error) {
    return [message(error)];
  }
  const toMap = (items: readonly unknown[], label: string) => {
    const output = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const record = objectValue(item, label);
      if (typeof record.id === "string") output.set(record.id, record);
    }
    return output;
  };
  const races = toMap(state.races, "种族");
  const groups = toMap(state.groups, "角色分组");
  const souls = toMap(state.souls, "角色灵魂");
  const characters = toMap(state.characters, "角色");
  const items = toMap(state.items, "物品库物品");
  const candidateIds = new Set<string>();

  for (const operation of operations) {
    if (
      !ID_PATTERN.test(operation.candidateId) ||
      candidateIds.has(operation.candidateId)
    ) {
      errors.push(`候选 id 非法或重复：${operation.candidateId}`);
    }
    candidateIds.add(operation.candidateId);
    if (!operation.summary.trim())
      errors.push(`${operation.candidateId}缺少摘要`);
    if (operation.action === "update" && !operation.targetId) {
      errors.push(`${operation.candidateId}更新候选缺少 targetId`);
      continue;
    }
    let id = "";
    try {
      id = operationId(operation.value, operation);
    } catch (error) {
      errors.push(message(error));
      continue;
    }
    const map =
      operation.kind === "race"
        ? races
        : operation.kind === "group"
          ? groups
          : operation.kind === "soul"
            ? souls
            : characters;
    if (operation.action === "create" && map.has(id)) {
      errors.push(`${operation.kind} id 已存在：${id}`);
      continue;
    }
    if (operation.action === "update" && !map.has(id)) {
      errors.push(`${operation.kind} id 不存在：${id}`);
      continue;
    }
    const current = map.get(id) ?? {};
    const next: Record<string, unknown> = {
      ...(current as Record<string, unknown>),
      ...operation.value,
      id,
    };
    validateCharacterDefinition(operation.kind, next, errors);
    if (operation.kind === "character") {
      const parsedCharacter = characterRecordSchema.safeParse(next);
      map.set(
        id,
        parsedCharacter.success
          ? (parsedCharacter.data as unknown as Record<string, unknown>)
          : next,
      );
    } else {
      map.set(id, next);
    }
  }

  for (const character of characters.values()) {
    const parsedCharacter = characterRecordSchema.safeParse(character);
    if (!parsedCharacter.success) continue;
    const { name, raceId, soulId, groupIds, relations, inventory } =
      parsedCharacter.data;
    if (raceId && !races.has(raceId)) {
      errors.push(`角色“${name}”引用了不存在的种族：${raceId}`);
    }
    if (soulId && !souls.has(soulId)) {
      errors.push(`角色“${name}”引用了不存在的角色灵魂：${soulId}`);
    }
    for (const groupId of groupIds) {
      if (!groups.has(groupId))
        errors.push(`角色“${name}”引用了不存在的分组：${groupId}`);
    }
    for (const relation of relations) {
      if (!characters.has(relation.targetId)) {
        errors.push(`角色“${name}”包含不存在的关系目标`);
      }
    }
    for (const item of inventory) {
      if (item.itemId && !items.has(item.itemId)) {
        errors.push(`角色“${name}”关联了不存在的物品库物品：${item.itemId}`);
      }
    }
  }
  await validateCharacterCultivationProfiles(
    workspace,
    [...characters.values()],
    errors,
  );
  return errors;
}

async function getCharacterContextHandler(args: {
  characterId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const state = await readCharacterLibraryState(workspace);
    const selected = args.characterId
      ? (state.characters
          .map((item) => objectValue(item, "角色"))
          .find((item) => item.id === args.characterId) ?? null)
      : null;
    return result({
      sourcePath: `${CHARACTER_LIBRARY_ROOT}/index.json`,
      sourceHash: hashNovelWorkbenchDraftPayload(state.sourceSnapshot),
      project: {
        title: state.novel.title ?? "",
        genres: state.novel.genres ?? [],
      },
      races: state.races,
      groups: state.groups,
      souls: state.souls,
      items: state.items.slice(0, 300).map((item) => {
        const entry = objectValue(item, "物品库物品");
        return {
          id: entry.id,
          name: entry.name,
          summary: entry.summary,
          status: entry.status,
          tags: entry.tags,
        };
      }),
      characters: state.characters.slice(0, 200).map((item) => {
        const character = objectValue(item, "角色");
        return {
          id: character.id,
          name: character.name,
          alias: character.alias,
          roleWeight: character.roleWeight,
          archetype: character.archetype,
          summary: character.summary,
          identities: character.identities,
          raceId: character.raceId,
          soulId: character.soulId,
          groupIds: character.groupIds,
          storyRole: character.storyRole,
          arc: character.arc,
          cultivationProfile: character.cultivationProfile,
        };
      }),
      selectedCharacter: selected,
      constraints: {
        operations: ["create", "update"],
        kinds: ["character", "race", "group", "soul"],
        maxOperations: MAX_CHARACTER_OPERATIONS,
        noDeletes: true,
      },
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateCharacterCultivationProfiles(
  workspace: string,
  characters: readonly Record<string, unknown>[],
  errors: string[],
): Promise<void> {
  let source: LoadedCultivationSource | null;
  try {
    source = await loadCultivationSource(workspace);
  } catch {
    errors.push("修行生态事实源无法解析，不能校验角色修行引用");
    return;
  }
  if (!source) return;
  const ecology = source.ecology;
  const systemIds = new Set(ecology.systems.map((system) => system.id));
  const trackToSystem = new Map(
    ecology.systems.flatMap((system) =>
      system.progressionTracks.map((track) => [track.id, system.id] as const),
    ),
  );
  const levelToTrack = new Map(
    ecology.systems.flatMap((system) =>
      system.progressionTracks.flatMap((track) =>
        track.levels.map((level) => [level.id, track.id] as const),
      ),
    ),
  );
  const methodIds = new Set(
    ecology.systems.flatMap((system) =>
      system.methods.map((method) => method.id),
    ),
  );
  const abilityIds = new Set(
    ecology.systems.flatMap((system) =>
      system.abilities.map((ability) => ability.id),
    ),
  );
  const constraintIds = new Set(
    ecology.systems.flatMap((system) =>
      system.constraints.map((constraint) => constraint.id),
    ),
  );
  const resourceIds = new Set(
    ecology.systems.flatMap((system) =>
      system.resources.map((resource) => resource.id),
    ),
  );
  const transitionIds = new Set(
    ecology.systems.flatMap((system) => [
      ...system.transitions.map((transition) => transition.id),
      ...system.progressionTracks.flatMap((track) =>
        track.transitions.map((transition) => transition.id),
      ),
    ]),
  );
  for (const character of characters) {
    const name =
      typeof character.name === "string" ? character.name : "未命名角色";
    const profile = character.cultivationProfile;
    if (!profile || typeof profile !== "object" || Array.isArray(profile))
      continue;
    const value = profile as Record<string, unknown>;
    const systemId = typeof value.systemId === "string" ? value.systemId : null;
    const trackId = typeof value.trackId === "string" ? value.trackId : null;
    const levelId = typeof value.levelId === "string" ? value.levelId : null;
    const hasBoundAssets =
      Boolean(trackId || levelId) ||
      (Array.isArray(value.methodIds) && value.methodIds.length > 0) ||
      (Array.isArray(value.abilityIds) && value.abilityIds.length > 0) ||
      (Array.isArray(value.activeConstraintIds) &&
        value.activeConstraintIds.length > 0) ||
      (Array.isArray(value.breakthroughHistory) &&
        value.breakthroughHistory.length > 0) ||
      (value.resourceBalances &&
        typeof value.resourceBalances === "object" &&
        Object.keys(value.resourceBalances).length > 0);
    if (!systemId && hasBoundAssets)
      errors.push(`角色“${name}”的修行档案存在资产，但未绑定修行体系`);
    if (systemId && !systemIds.has(systemId))
      errors.push(`角色“${name}”引用了不存在的修行体系：${systemId}`);
    if (trackId && !trackToSystem.has(trackId))
      errors.push(`角色“${name}”引用了不存在的成长轨道：${trackId}`);
    if (levelId && !levelToTrack.has(levelId))
      errors.push(`角色“${name}”引用了不存在的修行阶段：${levelId}`);
    if (systemId && trackId && trackToSystem.get(trackId) !== systemId)
      errors.push(`角色“${name}”的成长轨道不属于所选修行体系`);
    if (trackId && levelId && levelToTrack.get(levelId) !== trackId)
      errors.push(`角色“${name}”的修行阶段不属于所选成长轨道`);
    for (const [field, ids, label] of [
      ["methodIds", value.methodIds, "法门"],
      ["abilityIds", value.abilityIds, "能力"],
      ["activeConstraintIds", value.activeConstraintIds, "活跃约束"],
    ] as const) {
      if (!Array.isArray(ids)) continue;
      const valid =
        label === "法门"
          ? methodIds
          : label === "能力"
            ? abilityIds
            : constraintIds;
      ids.forEach((id) => {
        if (typeof id === "string" && !valid.has(id))
          errors.push(`角色“${name}”的 ${field} 引用了不存在的修行资产：${id}`);
      });
    }
    if (value.resourceBalances && typeof value.resourceBalances === "object") {
      Object.keys(value.resourceBalances).forEach((id) => {
        if (!resourceIds.has(id))
          errors.push(`角色“${name}”的内部资源引用了不存在的修行资产：${id}`);
      });
    }
    if (systemId) {
      const system = ecology.systems.find(
        (candidate) => candidate.id === systemId,
      );
      if (system) {
        const belongsToSystem = (
          id: string,
          kind: "method" | "ability" | "constraint" | "resource" | "transition",
        ) => {
          const collection =
            kind === "method"
              ? system.methods
              : kind === "ability"
                ? system.abilities
                : kind === "constraint"
                  ? system.constraints
                  : kind === "resource"
                    ? system.resources
                    : [
                        ...system.transitions,
                        ...system.progressionTracks.flatMap(
                          (track) => track.transitions,
                        ),
                      ];
          return collection.some((item) => item.id === id);
        };
        for (const id of Array.isArray(value.methodIds) ? value.methodIds : [])
          if (typeof id === "string" && !belongsToSystem(id, "method"))
            errors.push(`角色“${name}”的法门不属于所选修行体系：${id}`);
        for (const id of Array.isArray(value.abilityIds)
          ? value.abilityIds
          : [])
          if (typeof id === "string" && !belongsToSystem(id, "ability"))
            errors.push(`角色“${name}”的能力不属于所选修行体系：${id}`);
        for (const id of Array.isArray(value.activeConstraintIds)
          ? value.activeConstraintIds
          : [])
          if (typeof id === "string" && !belongsToSystem(id, "constraint"))
            errors.push(`角色“${name}”的活跃约束不属于所选修行体系：${id}`);
        if (
          value.resourceBalances &&
          typeof value.resourceBalances === "object"
        )
          for (const id of Object.keys(value.resourceBalances))
            if (!belongsToSystem(id, "resource"))
              errors.push(`角色“${name}”的内部资源不属于所选修行体系：${id}`);
        if (Array.isArray(value.breakthroughHistory))
          for (const entry of value.breakthroughHistory) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
              continue;
            const transitionId = (entry as Record<string, unknown>)
              .transitionId;
            if (
              typeof transitionId === "string" &&
              !belongsToSystem(transitionId, "transition")
            )
              errors.push(
                `角色“${name}”的突破记录不属于所选修行体系：${transitionId}`,
              );
          }
      }
    }
    if (Array.isArray(value.breakthroughHistory)) {
      value.breakthroughHistory.forEach((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const transitionId = (entry as Record<string, unknown>).transitionId;
        if (
          typeof transitionId === "string" &&
          !transitionIds.has(transitionId)
        )
          errors.push(
            `角色“${name}”的突破记录引用了不存在的跃迁：${transitionId}`,
          );
      });
    }
  }
}

type CultivationContextScope =
  | "all"
  | "theory"
  | "progression"
  | "resources"
  | "methods"
  | "abilities"
  | "formations"
  | "foundations"
  | "transitions"
  | "constraints";

async function getCultivationContextHandler(args: {
  systemId?: string;
  scope?: CultivationContextScope;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const source = await loadCultivationSource(workspace);
    if (source === null)
      return result({
        sourcePath: CULTIVATION_ECOLOGY_INDEX_PATH,
        sourceHash: hashNovelWorkbenchDraftPayload(""),
        systems: [],
        worldOrigins: [],
        crossSystemRelations: [],
      });
    const ecology = source.ecology;
    const selected = args.systemId
      ? ecology.systems.find((system) => system.id === args.systemId)
      : undefined;
    if (args.systemId && !selected)
      return result({ error: `不存在修行体系：${args.systemId}` }, true);
    // 本源摘要：AI 只需要稳定 ID、名称与显化结构，不需要画布坐标等编辑态数据。
    const summarizeOrigin = (
      origin: (typeof ecology.worldOrigins)[number],
      detailed: boolean,
    ) => ({
      id: origin.id,
      name: origin.name,
      kind: origin.kind,
      status: origin.status,
      summary: origin.summary,
      ...(detailed
        ? {
            ontologyStatement: origin.ontologyStatement,
            scopes: origin.scopes,
            constraints: origin.constraints,
          }
        : {}),
      manifestations: origin.manifestations.map((manifestation) => ({
        id: manifestation.id,
        name: manifestation.name,
        type: manifestation.type,
        summary: manifestation.summary,
        ...(detailed
          ? {
              definition: manifestation.definition,
              sourceId: manifestation.sourceId,
              scope: manifestation.scope,
              access: manifestation.access,
              generation: manifestation.generation,
              conversion: manifestation.conversion,
              risks: manifestation.risks,
            }
          : {}),
      })),
      relations: origin.relations.map((relation) => ({
        id: relation.id,
        name: relation.name,
        sourceId: relation.sourceId,
        targetId: relation.targetId,
        relation: relation.relation,
        ...(detailed
          ? {
              conditions: relation.conditions,
              cost: relation.cost,
              loss: relation.loss,
            }
          : {}),
      })),
    });
    // 体系摘要：列表模式下只给结构骨架与资产计数，避免全量大载荷。
    const summarizeSystem = (system: CultivationSystem) => ({
      id: system.id,
      name: system.name,
      kind: system.kind,
      summary: system.summary,
      progressionTracks: system.progressionTracks.map((track) => ({
        id: track.id,
        name: track.name,
        structure: track.structure,
        levels: track.levels.map((level) => ({
          id: level.id,
          name: level.name,
          order: level.order,
        })),
        transitions: track.transitions.map((transition) => ({
          id: transition.id,
          name: transition.name,
          transitionType: transition.transitionType,
        })),
      })),
      counts: {
        methods: system.methods.length,
        abilities: system.abilities.length,
        formations: system.formations.length,
        resources: system.resources.length,
        foundations: system.foundations.length,
        constraints: system.constraints.length,
        transitions: system.transitions.length,
      },
      audit: {
        errors: system.audit.filter((issue) => issue.severity === "error")
          .length,
        warnings: system.audit.filter((issue) => issue.severity === "warning")
          .length,
        suggestions: system.audit.filter(
          (issue) => issue.severity === "suggestion",
        ).length,
        unresolved: system.audit.filter((issue) => !issue.resolved).length,
      },
    });
    const fullSystem = (
      system: CultivationSystem,
      scope: CultivationContextScope,
    ) => {
      const include = (section: CultivationContextScope) =>
        scope === "all" || scope === section;
      const compact = (
        items: readonly { id: string; name: string; summary: string }[],
      ) =>
        items.map((item) => ({
          id: item.id,
          name: item.name,
          summary: item.summary,
        }));
      return {
        id: system.id,
        name: system.name,
        kind: system.kind,
        summary: system.summary,
        terminology: system.terminology,
        projection: system.projection,
        theoryModel: include("theory")
          ? system.theoryModel
          : {
              statement: system.theoryModel.statement,
              summary: system.theoryModel.summary,
              invariants: system.theoryModel.invariants,
              nodeCatalog: compact(system.theoryModel.nodeCatalog),
            },
        progressionTracks: include("progression")
          ? system.progressionTracks.map((track) => ({
              id: track.id,
              name: track.name,
              mode: track.mode,
              structure: track.structure,
              metrics: track.metrics,
              levels: track.levels.map((level) => ({
                id: level.id,
                name: level.name,
                order: level.order,
                quality: level.quality,
                entryConditions: level.entryConditions,
                maintenanceConditions: level.maintenanceConditions,
                breakthroughConditions: level.breakthroughConditions,
                resourceRequirements: level.resourceRequirements,
                naturalAbilityIds: level.naturalAbilityIds,
                methodIds: level.methodIds,
                subStages: level.subStages,
              })),
              transitions: track.transitions,
            }))
          : system.progressionTracks.map((track) => ({
              id: track.id,
              name: track.name,
              summary: track.summary,
              structure: track.structure,
              levels: track.levels.map((level) => ({
                id: level.id,
                name: level.name,
                order: level.order,
              })),
            })),
        trackInteractions: include("progression")
          ? system.trackInteractions
          : system.trackInteractions.map(({ id, name, summary, kind }) => ({
              id,
              name,
              summary,
              kind,
            })),
        resources: include("resources")
          ? system.resources
          : compact(system.resources),
        methods: include("methods") ? system.methods : compact(system.methods),
        abilities: include("abilities")
          ? system.abilities
          : compact(system.abilities),
        formations: include("formations")
          ? system.formations
          : compact(system.formations),
        foundations: include("foundations")
          ? system.foundations
          : compact(system.foundations),
        transitions: include("transitions")
          ? system.transitions
          : compact(system.transitions),
        constraints: include("constraints")
          ? system.constraints
          : compact(system.constraints),
        audit: system.audit,
        counts: {
          methods: system.methods.length,
          abilities: system.abilities.length,
          formations: system.formations.length,
          resources: system.resources.length,
          foundations: system.foundations.length,
          constraints: system.constraints.length,
          transitions: system.transitions.length,
        },
      };
    };
    const scope = args.scope ?? "all";
    const systems = selected
      ? [fullSystem(selected, scope)]
      : ecology.systems.map(summarizeSystem);
    const selectedOriginIds = selected
      ? new Set([
          ...selected.projection.originIds,
          ...ecology.worldOrigins
            .filter((origin) =>
              origin.manifestations.some((manifestation) =>
                selected.projection.manifestationIds.includes(manifestation.id),
              ),
            )
            .map((origin) => origin.id),
        ])
      : null;
    const payload = {
      schemaVersion: ecology.schemaVersion,
      sourcePath: CULTIVATION_ECOLOGY_INDEX_PATH,
      sourceHash: hashNovelWorkbenchDraftPayload(source.snapshot),
      worldOrigins: ecology.worldOrigins
        .filter(
          (origin) => !selectedOriginIds || selectedOriginIds.has(origin.id),
        )
        .map((origin) =>
          summarizeOrigin(origin, Boolean(selected && scope === "all")),
        ),
      systems,
      crossSystemRelations: selected
        ? ecology.crossSystemRelations.filter(
            (relation) =>
              relation.sourceSystemId === selected.id ||
              relation.targetSystemId === selected.id,
          )
        : ecology.crossSystemRelations,
      ...(selected ? { scope } : {}),
    };
    if (
      Buffer.byteLength(JSON.stringify(payload), "utf8") >
      MAX_CULTIVATION_CONTEXT_BYTES
    ) {
      return result(
        {
          error:
            "修行体系上下文过大，请传入 systemId 并按 theory、progression、methods、abilities、resources、formations、transitions 或 constraints 分模块读取",
        },
        true,
      );
    }
    return result(payload);
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

function parseCultivationDraftContent(content: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ecology: null,
      errors: [`修行生态草稿不是有效 JSON：${message(error)}`],
    };
  }
  const checked = cultivationEcologySchema.safeParse(parsed);
  if (!checked.success) {
    return {
      ecology: null,
      errors: checked.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}：${issue.message}`,
      ),
    };
  }
  return { ecology: checked.data, errors: [] as string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeRecord(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...base };
  Object.entries(patch).forEach(([key, value]) => {
    next[key] =
      isRecord(value) && isRecord(base[key])
        ? mergeRecord(base[key], value)
        : value;
  });
  return next;
}

function assertCultivationPatchFields(
  fields: Record<string, unknown>,
  path: string[] = [],
): void {
  for (const [key, value] of Object.entries(fields)) {
    const keyPath = [...path, key].join(".");
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`增量修订包含非法字段：${keyPath}`);
    }
    if (
      key === "id" ||
      key === "audit" ||
      key === "schemaVersion" ||
      key === "updatedAt"
    ) {
      throw new Error(`增量修订不得修改稳定字段：${keyPath}`);
    }
    if (isRecord(value)) assertCultivationPatchFields(value, [...path, key]);
  }
}

type CultivationLocatedObject = {
  value: Record<string, unknown>;
  parent: unknown[] | null;
  index: number;
};

function findCultivationObjectById(
  root: unknown,
  targetId: string,
): CultivationLocatedObject | null {
  const visited = new Set<object>();
  const visit = (
    value: unknown,
    parent: unknown[] | null,
    index: number,
  ): CultivationLocatedObject | null => {
    if (Array.isArray(value)) {
      for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
        const found = visit(value[itemIndex], value, itemIndex);
        if (found) return found;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    if (visited.has(value)) return null;
    visited.add(value);
    if (value.id === targetId) return { value, parent, index };
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        continue;
      const found = visit(child, null, -1);
      if (found) return found;
    }
    return null;
  };
  return visit(root, null, -1);
}

function appendCultivationValue(
  root: Record<string, unknown>,
  collection: string,
  parentId: string | undefined,
  value: unknown,
): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(collection))
    throw new Error(`增量修订的集合名称无效：${collection}`);
  const owner = parentId
    ? findCultivationObjectById(root, parentId)?.value
    : root;
  if (!owner) throw new Error(`增量修订找不到父对象：${parentId}`);
  const target = owner[collection];
  if (!Array.isArray(target))
    throw new Error(`增量修订目标不是数组：${collection}`);
  target.push(value);
}

function applyCultivationDraftPatches(
  content: string,
  operations: readonly CultivationDraftPatchOperation[],
): { content: string; changed: readonly string[] } {
  if (operations.length === 0) throw new Error("至少需要一项增量修订");
  if (operations.length > MAX_CULTIVATION_PATCH_OPERATIONS) {
    throw new Error(
      `单次最多提交 ${MAX_CULTIVATION_PATCH_OPERATIONS} 项修炼体系增量修订`,
    );
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(operations), "utf8");
  if (inputBytes > MAX_CULTIVATION_PATCH_BYTES) {
    throw new Error(
      `单次增量修订最多 ${MAX_CULTIVATION_PATCH_BYTES} 字节，请拆成多次调用`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`修行生态草稿不是有效 JSON：${message(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("修行生态草稿根节点必须是对象");
  const changed: string[] = [];
  for (const operation of operations) {
    if (operation.action === "merge") {
      const target = findCultivationObjectById(parsed, operation.targetId);
      if (!target)
        throw new Error(`增量修订找不到目标对象：${operation.targetId}`);
      assertCultivationPatchFields(operation.fields);
      Object.assign(target.value, mergeRecord(target.value, operation.fields));
      changed.push(`merge:${operation.targetId}`);
      continue;
    }
    if (operation.action === "append") {
      appendCultivationValue(
        parsed,
        operation.collection,
        operation.parentId,
        operation.value,
      );
      changed.push(
        `append:${operation.parentId ? `${operation.parentId}/` : ""}${operation.collection}`,
      );
      continue;
    }
    const target = findCultivationObjectById(parsed, operation.targetId);
    if (!target || !target.parent)
      throw new Error(`增量修订找不到可删除的目标对象：${operation.targetId}`);
    target.parent.splice(target.index, 1);
    changed.push(`remove:${operation.targetId}`);
  }
  const nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(nextContent, "utf8") > 8 * 1024 * 1024) {
    throw new Error("修行体系草稿超过 8 MB 限制");
  }
  return { content: nextContent, changed };
}

function summarizeCultivationDraft(
  draft: NovelWorkbenchDraft<CultivationDraftPayload>,
  includeContent = false,
) {
  const payload = includeContent
    ? draft.payload
    : {
        title: draft.payload.title,
        description: draft.payload.description,
        baseSourceHash: draft.payload.baseSourceHash,
        contentBytes: Buffer.byteLength(draft.payload.content, "utf8"),
        contentHash: hashNovelWorkbenchDraftPayload(draft.payload.content),
      };
  return {
    draftId: draft.draftId,
    domain: draft.domain,
    revision: draft.revision,
    validated:
      draft.validation?.revision === draft.revision
        ? {
            token: draft.validation.token,
            validatedAt: draft.validation.validatedAt,
          }
        : null,
    submittedProposalId: draft.submittedProposalId,
    updatedAt: draft.updatedAt,
    payload,
  };
}

async function validateCultivationEcologyForWorkspace(
  workspace: string,
  ecology: CultivationEcology,
): Promise<readonly string[]> {
  const itemIndexContent = await readOptional(
    workspaceFile(workspace, "world/items/index.json"),
  );
  const itemIds = itemIndexContent
    ? await readIdSet(workspace, "world/items/index.json", "items")
    : undefined;
  return validateCultivationEcology(ecology, { itemIds });
}

async function createCultivationDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
  baseSourceHash: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("cultivation");
    const current = await loadCultivationSource(workspace);
    if (current === null) throw new Error("修行体系事实源不存在");
    const currentHash = hashNovelWorkbenchDraftPayload(current.snapshot);
    if (args.baseSourceHash !== currentHash) {
      throw new Error("修行体系事实源已变化，请重新读取上下文后创建草稿");
    }
    const draft = await createNovelWorkbenchDraft<CultivationDraftPayload>(
      workspace,
      "cultivation",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        baseSourceHash: args.baseSourceHash,
        content: current.aggregateContent,
      },
      args.draftId,
    );
    return result(summarizeCultivationDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getCultivationDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("cultivation");
    return result(
      summarizeCultivationDraft(
        await loadNovelWorkbenchDraft<CultivationDraftPayload>(
          workspace,
          "cultivation",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertCultivationDraftHandler(args: {
  draftId: string;
  content: string;
}): Promise<CallToolResult> {
  try {
    if (Buffer.byteLength(args.content, "utf8") > MAX_CULTIVATION_PATCH_BYTES) {
      throw new Error(
        `整份修行生态替换内容超过 ${MAX_CULTIVATION_PATCH_BYTES} 字节，请改用 novel_cultivation_patch_draft 分批写入`,
      );
    }
    const { workspace } = requireDraftMode("cultivation");
    const draft = await updateNovelWorkbenchDraft<CultivationDraftPayload>(
      workspace,
      "cultivation",
      args.draftId,
      (payload) => ({ ...payload, content: args.content }),
    );
    return result(summarizeCultivationDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function patchCultivationDraftHandler(args: {
  draftId: string;
  operations: CultivationDraftPatchOperation[];
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("cultivation");
    let changed: readonly string[] = [];
    const draft = await updateNovelWorkbenchDraft<CultivationDraftPayload>(
      workspace,
      "cultivation",
      args.draftId,
      (payload) => {
        const result = applyCultivationDraftPatches(
          payload.content,
          args.operations,
        );
        changed = result.changed;
        return { ...payload, content: result.content };
      },
    );
    return result({ ...summarizeCultivationDraft(draft), changed });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateCultivationDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("cultivation");
    const draft = await loadNovelWorkbenchDraft<CultivationDraftPayload>(
      workspace,
      "cultivation",
      args.draftId,
    );
    const current = await loadCultivationSource(workspace);
    const currentHash = hashNovelWorkbenchDraftPayload(current?.snapshot ?? "");
    if (draft.payload.baseSourceHash !== currentHash) {
      return result(
        {
          valid: false,
          errors: ["修行体系事实源已变化，请重新读取上下文并创建草稿"],
        },
        true,
      );
    }
    const parsed = parseCultivationDraftContent(draft.payload.content);
    if (parsed.errors.length > 0) {
      return result({ valid: false, errors: parsed.errors }, true);
    }
    if (!parsed.ecology)
      return result({ valid: false, errors: ["修行生态草稿为空"] }, true);
    const semanticErrors = await validateCultivationEcologyForWorkspace(
      workspace,
      parsed.ecology,
    );
    if (semanticErrors.length > 0) {
      return result(
        { valid: false, errors: semanticErrors.slice(0, 100) },
        true,
      );
    }
    const canonicalContent = `${JSON.stringify(parsed.ecology, null, 2)}\n`;
    let validatedDraft = draft;
    let normalized = false;
    if (canonicalContent !== draft.payload.content) {
      validatedDraft = await updateNovelWorkbenchDraft<CultivationDraftPayload>(
        workspace,
        "cultivation",
        draft.draftId,
        (payload) => {
          if (payload.content !== draft.payload.content) {
            throw new Error("草稿在规范化期间发生变化，请重新校验");
          }
          return { ...payload, content: canonicalContent };
        },
      );
      normalized = true;
    }
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      validatedDraft,
      hashNovelWorkbenchDraftPayload(validatedDraft.payload),
    );
    return result({
      valid: true,
      normalized,
      ...summarizeCultivationDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitCultivationDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    const { workspace, context } = requireDraftMode("cultivation");
    const draft = await loadNovelWorkbenchDraft<CultivationDraftPayload>(
      workspace,
      "cultivation",
      args.draftId,
    );
    const hash = hashNovelWorkbenchDraftPayload(draft.payload);
    if (draft.submittedProposalId) {
      return result(
        await getProposalStatus(
          CULTIVATION_PROPOSAL_ROOT,
          draft.submittedProposalId,
          "changes",
        ),
      );
    }
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !== hash
    ) {
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    }
    const before = await loadCultivationSource(workspace);
    if (before === null) throw new Error("修行体系事实源不存在");
    if (
      hashNovelWorkbenchDraftPayload(before.snapshot) !==
      draft.payload.baseSourceHash
    ) {
      throw new Error("修行体系事实源已变化，请重新读取上下文并创建草稿");
    }
    const parsed = parseCultivationDraftContent(draft.payload.content);
    if (parsed.errors.length > 0) throw new Error(parsed.errors.join("；"));
    if (!parsed.ecology) throw new Error("修行生态草稿为空");
    const semanticErrors = await validateCultivationEcologyForWorkspace(
      workspace,
      parsed.ecology,
    );
    if (semanticErrors.length > 0)
      throw new Error(semanticErrors.slice(0, 100).join("；"));
    const nextEcology = cultivationEcologySchema.parse({
      ...parsed.ecology,
      updatedAt: new Date().toISOString(),
    });
    const afterFiles = cultivationFileMap(
      createCultivationEcologyFiles(nextEcology),
    );
    const changedFiles = [...afterFiles.entries()]
      .filter(([path, content]) => before.files.get(path) !== content)
      .sort(([left], [right]) => left.localeCompare(right));
    if (changedFiles.length === 0) throw new Error("修行体系草稿没有产生变更");

    const proposalId = `cultivation-${draft.draftId}`;
    proposalDirectory = workspaceFile(
      workspace,
      `${CULTIVATION_PROPOSAL_ROOT}/${proposalId}`,
    );
    const proposalFile = join(proposalDirectory, "proposal.json");
    if (await readOptional(proposalFile)) {
      await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
      return result(
        await getProposalStatus(
          CULTIVATION_PROPOSAL_ROOT,
          proposalId,
          "changes",
        ),
      );
    }
    await fs.mkdir(join(workspace, CULTIVATION_PROPOSAL_ROOT), {
      recursive: true,
    });
    await fs.mkdir(join(proposalDirectory, "before"), { recursive: true });
    await fs.mkdir(join(proposalDirectory, "after"), { recursive: true });
    createdProposalDirectory = true;
    const manifest = {
      schemaVersion: 1,
      proposalId,
      title: draft.payload.title,
      description: draft.payload.description,
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent" as const,
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      changes: changedFiles.map(([targetPath], index) => ({
        id: `cultivation-change-${index + 1}`,
        targetPath,
        operation: before.files.has(targetPath)
          ? ("modify" as const)
          : ("create" as const),
        summary: draft.payload.description || `更新修行体系模块 ${targetPath}`,
        status: "pending" as const,
      })),
    };
    await fs.writeFile(proposalFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    for (const [targetPath, afterContent] of changedFiles) {
      const beforePath = join(
        proposalDirectory,
        "before",
        ...targetPath.split("/"),
      );
      const afterPath = join(
        proposalDirectory,
        "after",
        ...targetPath.split("/"),
      );
      await fs.mkdir(dirname(beforePath), { recursive: true });
      await fs.mkdir(dirname(afterPath), { recursive: true });
      await fs.writeFile(beforePath, before.files.get(targetPath) ?? "", {
        encoding: "utf8",
        flag: "wx",
      });
      await fs.writeFile(afterPath, afterContent, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    return result({
      submitted: true,
      proposalId,
      reviewAction: "请作者在修行体系页面打开“审阅提案”并审批。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getCultivationProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    requireDraftMode("cultivation");
    return result(
      await getProposalStatus(
        CULTIVATION_PROPOSAL_ROOT,
        args.proposalId,
        "changes",
      ),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

async function validateCharacterProposalHandler(args: {
  operations: CharacterProposalOperation[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.operations, "人物库候选");
    const errors = await validateCharacterProposal(args.operations);
    return result({ valid: errors.length === 0, errors }, errors.length > 0);
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitCharacterProposalHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  operations: CharacterProposalOperation[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    assertIncrementalBatch(args.operations, "人物库候选");
    const { workspace, context } = requireWorkspace();
    const errors = await validateCharacterProposal(args.operations);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const state = await readCharacterLibraryState(workspace);
    const recordsByKind = new Map<
      CharacterProposalOperation["kind"],
      Map<string, Record<string, unknown>>
    >();
    const mapRecords = (values: readonly unknown[]) =>
      new Map(
        values.flatMap((value) => {
          const record = objectValue(value, "人物提案基线");
          return typeof record.id === "string"
            ? [[record.id, record] as const]
            : [];
        }),
      );
    recordsByKind.set("character", mapRecords(state.characters));
    recordsByKind.set("race", mapRecords(state.races));
    recordsByKind.set("group", mapRecords(state.groups));
    recordsByKind.set("soul", mapRecords(state.souls));
    const proposalId =
      args.proposalId?.trim() ||
      `character-proposal-${randomUUID().slice(0, 8)}`;
    if (!ID_PATTERN.test(proposalId)) {
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    }
    const proposalsDirectory = workspaceFile(
      workspace,
      CHARACTER_PROPOSAL_ROOT,
    );
    proposalDirectory = workspaceFile(
      workspace,
      `${CHARACTER_PROPOSAL_ROOT}/${proposalId}`,
    );
    if (await readOptional(join(proposalDirectory, "proposal.json"))) {
      return result({
        submitted: true,
        proposalId,
        recovered: true,
        reviewAction: "请作者在小说工作台的人物库中审阅并采纳候选。",
      });
    }
    await fs.mkdir(proposalsDirectory, { recursive: true });
    await fs.mkdir(proposalDirectory);
    createdProposalDirectory = true;
    const manifest = {
      schemaVersion: 1,
      proposalId,
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent",
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      operations: args.operations.map((operation) => ({
        ...operation,
        ...(operation.action === "update" && operation.targetId
          ? {
              baseValue: recordsByKind
                .get(operation.kind)
                ?.get(operation.targetId),
            }
          : {}),
        summary: operation.summary.trim(),
        status: "pending",
      })),
    };
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return result({
      submitted: true,
      proposalId,
      operationCount: manifest.operations.length,
      reviewAction: "请作者在小说工作台的人物库中审阅并采纳候选。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

type FactionProposalOperation = {
  candidateId: string;
  kind: "faction";
  action: "create" | "update";
  targetId?: string;
  summary: string;
  baseValue?: Record<string, unknown> | null;
  value: Record<string, unknown>;
};

type TimelineProposalOperation = {
  candidateId: string;
  kind: "event";
  action: "create" | "update";
  targetId?: string;
  summary: string;
  baseValue?: Record<string, unknown> | null;
  value: Record<string, unknown>;
};

type MapProposalOperation = {
  candidateId: string;
  kind: "map";
  action: "create" | "update";
  targetId?: string;
  summary: string;
  value: Record<string, unknown>;
};

const FACTION_PROPOSAL_ROOT = "world/factions/proposals";
const TIMELINE_PROPOSAL_ROOT = "timeline/proposals";
const MAX_FACTION_OPERATIONS = 40;
const FACTION_RECORD_FIELDS = new Set([
  "id",
  "name",
  "type",
  "status",
  "summary",
  "state",
  "territories",
  "members",
  "assets",
  "resources",
  "organizationUnits",
  "relations",
  "rights",
  "links",
  "createdAt",
  "updatedAt",
]);
const MAX_TIMELINE_OPERATIONS = 40;
const MAP_PROPOSAL_ROOT = "world/maps/proposals";
const MAX_MAP_OPERATIONS = 40;

async function loadFactionSource(workspace: string) {
  const loaded = await loadFactionFiles((path) =>
    fs.readFile(workspaceFile(workspace, path), "utf8"),
  );
  return {
    library: loaded.library,
    snapshot: serializeFactionFileSnapshot(loaded.files),
  };
}

/** 读取工作区 JSON 文件并返回其 id 集合；文件缺失时返回空集。 */
export async function readIdSet(
  workspace: string,
  path: string,
  field: string,
): Promise<Set<string>> {
  const content = await readOptional(workspaceFile(workspace, path));
  if (!content) return new Set();
  const document = JSON.parse(content) as unknown;
  const list = arrayField(
    document && typeof document === "object"
      ? (document as Record<string, unknown>)
      : {},
    field,
  );
  const ids = new Set<string>();
  for (const item of list ?? []) {
    const record = objectValue(item, path);
    if (typeof record.id === "string") ids.add(record.id);
  }
  return ids;
}

/** 校验势力候选：结构、正式库存在性、跨库引用（角色/物品/空间节点）。 */
async function validateFactionDraftPayload(
  operations: readonly FactionProposalOperation[],
): Promise<string[]> {
  const { workspace, context } = requireWorkspace();
  if (context.mode !== "factions") {
    return ["当前受控会话不是势力组织设计会话"];
  }
  if (operations.length === 0) return ["至少需要一个势力候选"];
  if (operations.length > MAX_FACTION_OPERATIONS) {
    return [`单份势力提案最多包含 ${MAX_FACTION_OPERATIONS} 项候选`];
  }
  const errors: string[] = [];
  let existing: Record<string, unknown>[] = [];
  try {
    existing = (await loadFactionSource(workspace)).library.factions.map(
      (item) => objectValue(item, "势力"),
    );
  } catch (error) {
    return [`势力库读取失败：${message(error)}`];
  }
  const existingIds = new Set(
    existing
      .map((item) => objectValue(item, "势力").id)
      .filter((id) => typeof id === "string"),
  );
  const characterIds = await readIdSet(
    workspace,
    "characters/index.json",
    "characters",
  );
  const itemIds = await readIdSet(workspace, "world/items/index.json", "items");
  let spatialNodeIds = new Set<string>();
  try {
    const content = await readOptional(
      workspaceFile(workspace, "world/setting-library/spatial-tree.json"),
    );
    if (content) {
      const document = JSON.parse(content) as unknown;
      const nodes = arrayField(
        document && typeof document === "object"
          ? (document as Record<string, unknown>)
          : {},
        "nodes",
      );
      const ids = new Set<string>();
      for (const node of nodes ?? []) {
        const record = objectValue(node, "空间节点");
        if (typeof record.id === "string") ids.add(record.id);
      }
      spatialNodeIds = ids;
    }
  } catch {
    // 空间树缺失时不做节点校验，采纳阶段仍由前端严格校验
  }
  const candidateIds = new Set<string>();
  for (const operation of operations) {
    if (
      !ID_PATTERN.test(operation.candidateId) ||
      candidateIds.has(operation.candidateId)
    ) {
      errors.push(`候选 id 非法或重复：${operation.candidateId}`);
    }
    candidateIds.add(operation.candidateId);
    if (!operation.summary.trim())
      errors.push(`${operation.candidateId}缺少摘要`);
    if (operation.action === "update" && !operation.targetId) {
      errors.push(`${operation.candidateId}更新候选缺少 targetId`);
      continue;
    }
    const faction = operation.value;
    const unknownFields = Object.keys(faction).filter(
      (field) => !FACTION_RECORD_FIELDS.has(field),
    );
    if (unknownFields.length > 0) {
      errors.push(
        `势力候选“${operation.candidateId}”包含非正式字段：${unknownFields.join("、")}。核心目标和演化钩子请写入 links，层级写入 organizationUnits，关键成员写入 members，权利写入 rights，地域写入 territories`,
      );
    }
    const id = faction.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      errors.push(`${operation.candidateId}的势力 id 非法`);
      continue;
    }
    if (typeof faction.name !== "string" || !faction.name.trim()) {
      errors.push(`势力“${id}”缺少名称`);
    }
    if (operation.action === "create" && existingIds.has(id)) {
      errors.push(`势力 id 已存在：${id}`);
      continue;
    }
    if (operation.action === "update" && !existingIds.has(id)) {
      errors.push(`势力 id 不存在：${id}`);
      continue;
    }
    if (operation.action === "update" && operation.targetId !== id) {
      errors.push(
        `${operation.candidateId}的 value.id 必须与 targetId 保持一致`,
      );
      continue;
    }
    for (const member of arrayField(faction, "members") ?? []) {
      const record = objectValue(member, "成员");
      if (
        typeof record.characterId === "string" &&
        record.characterId &&
        !characterIds.has(record.characterId)
      ) {
        errors.push(
          `势力“${id}”的成员“${record.name ?? "未命名"}”关联了不存在的角色：${record.characterId}`,
        );
      }
    }
    for (const resource of arrayField(faction, "resources") ?? []) {
      const record = objectValue(resource, "资源");
      if (
        typeof record.itemId === "string" &&
        record.itemId &&
        !itemIds.has(record.itemId)
      ) {
        errors.push(
          `势力“${id}”的资源“${record.name ?? "未命名"}”关联了不存在的物品：${record.itemId}`,
        );
      }
      if (
        typeof record.worldNodeId === "string" &&
        record.worldNodeId &&
        !spatialNodeIds.has(record.worldNodeId)
      ) {
        errors.push(
          `势力“${id}”的资源“${record.name ?? "未命名"}”关联了不存在的空间节点：${record.worldNodeId}`,
        );
      }
    }
    for (const territory of arrayField(faction, "territories") ?? []) {
      const record = objectValue(territory, "领地");
      if (
        typeof record.worldNodeId === "string" &&
        record.worldNodeId &&
        !spatialNodeIds.has(record.worldNodeId)
      ) {
        errors.push(
          `势力“${id}”的领地“${record.name ?? "未命名"}”关联了不存在的空间节点：${record.worldNodeId}`,
        );
      }
    }
  }
  return errors;
}

async function attachFactionGenerationBaselines(
  workspace: string,
  operations: readonly FactionProposalOperation[],
): Promise<FactionProposalOperation[]> {
  const current = await loadFactionSource(workspace);
  const byId = new Map(
    current.library.factions.map((faction) => [faction.id, faction] as const),
  );
  return operations.map((operation) => {
    if (operation.action === "create") {
      return { ...operation, baseValue: null };
    }
    const targetId = operation.targetId;
    const baseValue = targetId ? byId.get(targetId) : undefined;
    if (!baseValue) {
      throw new Error(
        `无法为更新候选“${operation.candidateId}”保存生成基准：目标势力不存在`,
      );
    }
    return { ...operation, baseValue: { ...baseValue } };
  });
}

/** 校验时间线候选：结构、正式库存在性、跨库引用（角色/地点/章节/势力/物品）。 */
async function loadTimelineSource(workspace: string) {
  const loaded = await loadTimelineFiles((path) =>
    fs.readFile(workspaceFile(workspace, path), "utf8"),
  );
  return {
    library: loaded.library,
    snapshot: serializeTimelineFileSnapshot(loaded.files),
  };
}

async function attachTimelineGenerationBaselines(
  workspace: string,
  operations: readonly TimelineProposalOperation[],
): Promise<TimelineProposalOperation[]> {
  const current = await loadTimelineSource(workspace);
  const byId = new Map(
    current.library.events.map((event) => [event.id, event] as const),
  );
  return operations.map((operation) => {
    if (operation.action === "create") {
      return { ...operation, baseValue: null };
    }
    const targetId = operation.targetId;
    const baseValue = targetId ? byId.get(targetId) : undefined;
    if (!baseValue) {
      throw new Error(
        `无法为更新候选“${operation.candidateId}”保存生成基准：目标事件不存在`,
      );
    }
    return { ...operation, baseValue: { ...baseValue } };
  });
}

async function validateTimelineDraftPayload(
  operations: readonly TimelineProposalOperation[],
): Promise<string[]> {
  const { workspace, context } = requireWorkspace();
  if (context.mode !== "timeline") {
    return ["当前受控会话不是时间线设计会话"];
  }
  if (operations.length === 0) return ["至少需要一个时间线候选"];
  if (operations.length > MAX_TIMELINE_OPERATIONS) {
    return [`单份时间线提案最多包含 ${MAX_TIMELINE_OPERATIONS} 项候选`];
  }
  const errors: string[] = [];
  let existingEvents: Record<string, unknown>[] = [];
  let branchIds = new Set<string>();
  try {
    const source = await loadTimelineSource(workspace);
    existingEvents = source.library.events.map((item) =>
      objectValue(item, "事件"),
    );
    branchIds = new Set(
      source.library.branches
        .map((item) => objectValue(item, "分支").id)
        .filter((id): id is string => typeof id === "string"),
    );
  } catch (error) {
    return [`时间线读取失败：${message(error)}`];
  }
  const existingIds = new Set(
    existingEvents
      .map((item) => objectValue(item, "事件").id)
      .filter((id) => typeof id === "string"),
  );
  const characterIds = await readIdSet(
    workspace,
    "characters/index.json",
    "characters",
  );
  const factionIds = await readIdSet(
    workspace,
    FACTION_LIBRARY_PATH,
    "factions",
  );
  const itemIds = await readIdSet(workspace, "world/items/index.json", "items");
  const locationIds = await readIdSet(
    workspace,
    "world/locations/index.json",
    "locations",
  );
  const chapterIds = await readIdSet(
    workspace,
    MANUSCRIPT_INDEX_PATH,
    "chapters",
  );
  const candidateIds = new Set<string>();
  for (const operation of operations) {
    if (
      !ID_PATTERN.test(operation.candidateId) ||
      candidateIds.has(operation.candidateId)
    ) {
      errors.push(`候选 id 非法或重复：${operation.candidateId}`);
    }
    candidateIds.add(operation.candidateId);
    if (!operation.summary.trim())
      errors.push(`${operation.candidateId}缺少摘要`);
    if (operation.action === "update" && !operation.targetId) {
      errors.push(`${operation.candidateId}更新候选缺少 targetId`);
      continue;
    }
    const event = operation.value;
    const id = event.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      errors.push(`${operation.candidateId}的事件 id 非法`);
      continue;
    }
    if (typeof event.title !== "string" || !event.title.trim()) {
      errors.push(`事件“${id}”缺少标题`);
    }
    if (typeof event.branchId === "string" && !branchIds.has(event.branchId)) {
      errors.push(`事件“${id}”所属分支不存在：${event.branchId}`);
    }
    if (operation.action === "create" && existingIds.has(id)) {
      errors.push(`事件 id 已存在：${id}`);
      continue;
    }
    if (operation.action === "update" && !existingIds.has(id)) {
      errors.push(`事件 id 不存在：${id}`);
      continue;
    }
    if (operation.action === "update" && operation.targetId !== id) {
      errors.push(
        `${operation.candidateId}的 value.id 必须与 targetId 保持一致`,
      );
      continue;
    }
    const checkReference = (
      field: string,
      available: Set<string>,
      label: string,
    ) => {
      for (const ref of arrayField(event, field) ?? []) {
        if (typeof ref === "string" && ref && !available.has(ref)) {
          errors.push(`事件“${id}”关联了不存在的${label}：${ref}`);
        }
      }
    };
    checkReference("characterIds", characterIds, "角色");
    checkReference("factionIds", factionIds, "势力");
    checkReference("itemIds", itemIds, "物品");
    checkReference("locationIds", locationIds, "地点");
    checkReference("chapterIds", chapterIds, "正文章节");
  }
  return errors;
}

async function submitFactionProposalHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  operations: FactionProposalOperation[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    assertIncrementalBatch(args.operations, "势力候选");
    const { workspace, context } = requireWorkspace();
    const errors = await validateFactionDraftPayload(args.operations);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const proposalId =
      args.proposalId?.trim() || `faction-proposal-${randomUUID().slice(0, 8)}`;
    if (!ID_PATTERN.test(proposalId)) {
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    }
    proposalDirectory = workspaceFile(
      workspace,
      `${FACTION_PROPOSAL_ROOT}/${proposalId}`,
    );
    if (await readOptional(join(proposalDirectory, "proposal.json"))) {
      return result({
        submitted: true,
        proposalId,
        recovered: true,
        reviewAction: "请作者在小说工作台的势力组织中审阅并采纳候选。",
      });
    }
    await fs.mkdir(proposalDirectory, { recursive: true });
    createdProposalDirectory = true;
    const operations = await attachFactionGenerationBaselines(
      workspace,
      args.operations,
    );
    const manifest = {
      schemaVersion: 1,
      proposalId,
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent",
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      operations: operations.map((operation) => ({
        ...operation,
        summary: operation.summary.trim(),
        status: "pending",
      })),
    };
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return result({
      submitted: true,
      proposalId,
      operationCount: manifest.operations.length,
      reviewAction: "请作者在小说工作台的势力组织中审阅并采纳候选。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function submitTimelineProposalHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  operations: TimelineProposalOperation[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    assertIncrementalBatch(args.operations, "时间线候选");
    const { workspace, context } = requireWorkspace();
    const errors = await validateTimelineDraftPayload(args.operations);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const proposalId =
      args.proposalId?.trim() ||
      `timeline-proposal-${randomUUID().slice(0, 8)}`;
    if (!ID_PATTERN.test(proposalId)) {
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    }
    proposalDirectory = workspaceFile(
      workspace,
      `${TIMELINE_PROPOSAL_ROOT}/${proposalId}`,
    );
    if (await readOptional(join(proposalDirectory, "proposal.json"))) {
      return result({
        submitted: true,
        proposalId,
        recovered: true,
        reviewAction: "请作者在小说工作台的时间线中审阅并采纳候选。",
      });
    }
    await fs.mkdir(proposalDirectory, { recursive: true });
    createdProposalDirectory = true;
    const operations = await attachTimelineGenerationBaselines(
      workspace,
      args.operations,
    );
    const manifest = {
      schemaVersion: 1,
      proposalId,
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent",
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      operations: operations.map((operation) => ({
        ...operation,
        summary: operation.summary.trim(),
        status: "pending",
      })),
    };
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return result({
      submitted: true,
      proposalId,
      operationCount: manifest.operations.length,
      reviewAction: "请作者在小说工作台的时间线中审阅并采纳候选。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

type FactionDraftPayload = {
  title: string;
  description: string;
  operations: FactionProposalOperation[];
};

type TimelineDraftPayload = {
  title: string;
  description: string;
  operations: TimelineProposalOperation[];
};

async function createFactionDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("factions");
    const draft = await createNovelWorkbenchDraft<FactionDraftPayload>(
      workspace,
      "factions",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        operations: [],
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getFactionDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("factions");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<FactionDraftPayload>(
          workspace,
          "factions",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertFactionDraftOperationsHandler(args: {
  draftId: string;
  operations: FactionProposalOperation[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.operations, "势力候选");
    const { workspace } = requireDraftMode("factions");
    const draft = await updateNovelWorkbenchDraft<FactionDraftPayload>(
      workspace,
      "factions",
      args.draftId,
      (payload) => {
        const operations = new Map(
          payload.operations.map((operation) => [
            operation.candidateId,
            operation,
          ]),
        );
        for (const operation of args.operations) {
          const previous = operations.get(operation.candidateId);
          operations.set(
            operation.candidateId,
            previous
              ? {
                  ...operation,
                  value: mergeRecord(previous.value, operation.value),
                }
              : operation,
          );
        }
        return { ...payload, operations: [...operations.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateFactionDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("factions");
    const draft = await loadNovelWorkbenchDraft<FactionDraftPayload>(
      workspace,
      "factions",
      args.draftId,
    );
    const errors = await validateFactionDraftPayload(draft.payload.operations);
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(draft.payload),
    );
    return result({
      valid: true,
      ...summarizeNovelWorkbenchDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitFactionDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("factions");
    const draft = await loadNovelWorkbenchDraft<FactionDraftPayload>(
      workspace,
      "factions",
      args.draftId,
    );
    const hash = hashNovelWorkbenchDraftPayload(draft.payload);
    if (draft.submittedProposalId) {
      return result(
        await getProposalStatus(
          FACTION_PROPOSAL_ROOT,
          draft.submittedProposalId,
          "operations",
        ),
      );
    }
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !== hash
    ) {
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    }
    const proposalId = `factions-${draft.draftId}`;
    const submitted = await submitFactionProposalHandler({
      proposalId,
      ...draft.payload,
    });
    if (submitted.isError) return submitted;
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    return result({ ...decodeToolResult(submitted), draftId: draft.draftId });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getFactionProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    requireDraftMode("factions");
    return result(
      await getProposalStatus(
        FACTION_PROPOSAL_ROOT,
        args.proposalId,
        "operations",
      ),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

async function createTimelineDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("timeline");
    const draft = await createNovelWorkbenchDraft<TimelineDraftPayload>(
      workspace,
      "timeline",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        operations: [],
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getTimelineDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("timeline");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<TimelineDraftPayload>(
          workspace,
          "timeline",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertTimelineDraftOperationsHandler(args: {
  draftId: string;
  operations: TimelineProposalOperation[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.operations, "时间线候选");
    const { workspace } = requireDraftMode("timeline");
    const draft = await updateNovelWorkbenchDraft<TimelineDraftPayload>(
      workspace,
      "timeline",
      args.draftId,
      (payload) => {
        const operations = new Map(
          payload.operations.map((operation) => [
            operation.candidateId,
            operation,
          ]),
        );
        for (const operation of args.operations) {
          const previous = operations.get(operation.candidateId);
          operations.set(
            operation.candidateId,
            previous
              ? {
                  ...operation,
                  value: mergeRecord(previous.value, operation.value),
                }
              : operation,
          );
        }
        return { ...payload, operations: [...operations.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateTimelineDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("timeline");
    const draft = await loadNovelWorkbenchDraft<TimelineDraftPayload>(
      workspace,
      "timeline",
      args.draftId,
    );
    const errors = await validateTimelineDraftPayload(draft.payload.operations);
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(draft.payload),
    );
    return result({
      valid: true,
      ...summarizeNovelWorkbenchDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitTimelineDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("timeline");
    const draft = await loadNovelWorkbenchDraft<TimelineDraftPayload>(
      workspace,
      "timeline",
      args.draftId,
    );
    const hash = hashNovelWorkbenchDraftPayload(draft.payload);
    if (draft.submittedProposalId) {
      return result(
        await getProposalStatus(
          TIMELINE_PROPOSAL_ROOT,
          draft.submittedProposalId,
          "operations",
        ),
      );
    }
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !== hash
    ) {
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    }
    const proposalId = `timeline-${draft.draftId}`;
    const submitted = await submitTimelineProposalHandler({
      proposalId,
      ...draft.payload,
    });
    if (submitted.isError) return submitted;
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    return result({ ...decodeToolResult(submitted), draftId: draft.draftId });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getTimelineProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    requireDraftMode("timeline");
    return result(
      await getProposalStatus(
        TIMELINE_PROPOSAL_ROOT,
        args.proposalId,
        "operations",
      ),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

/** 校验地图候选：结构（id/name/projectionType/layers/features）与正式库存在性。 */
async function validateMapDraftPayload(
  operations: readonly MapProposalOperation[],
): Promise<string[]> {
  const { workspace, context } = requireWorkspace();
  if (context.mode !== "maps") {
    return ["当前受控会话不是地图设计会话"];
  }
  if (operations.length === 0) return ["至少需要一个地图候选"];
  if (operations.length > MAX_MAP_OPERATIONS) {
    return ["单份地图提案最多包含 " + MAX_MAP_OPERATIONS + " 项候选"];
  }
  const errors: string[] = [];
  let existingIds = new Set<string>();
  try {
    const content = await readOptional(
      workspaceFile(workspace, "world/maps/index.json"),
    );
    if (content) {
      const index = JSON.parse(content) as { maps?: unknown[] };
      existingIds = new Set(
        (index.maps ?? [])
          .map((entry) => objectValue(entry, "地图").id)
          .filter((id): id is string => typeof id === "string"),
      );
    }
  } catch {
    // 索引缺失时按空库处理
  }
  const candidateIds = new Set<string>();
  for (const operation of operations) {
    if (
      !ID_PATTERN.test(operation.candidateId) ||
      candidateIds.has(operation.candidateId)
    ) {
      errors.push("候选 id 非法或重复：" + operation.candidateId);
    }
    candidateIds.add(operation.candidateId);
    if (!operation.summary.trim())
      errors.push(operation.candidateId + "缺少摘要");
    if (operation.action === "update" && !operation.targetId) {
      errors.push(operation.candidateId + "更新候选缺少 targetId");
      continue;
    }
    const map = operation.value;
    const id = map.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      errors.push(operation.candidateId + "的地图 id 非法");
      continue;
    }
    if (typeof map.name !== "string" || !map.name.trim()) {
      errors.push("地图“" + id + "”缺少名称");
    }
    if (
      !["continent", "planet", "multiverse", "parallel"].includes(
        String(map.projectionType),
      )
    ) {
      errors.push("地图“" + id + "”投影类型非法");
    }
    if (!Array.isArray(map.layers) || map.layers.length === 0) {
      errors.push("地图“" + id + "”至少需要一个图层");
    }
    if (!Array.isArray(map.features)) {
      errors.push("地图“" + id + "”缺少要素数组");
    }
    if (operation.action === "create" && existingIds.has(id)) {
      errors.push("地图 id 已存在：" + id);
    }
    if (operation.action === "update" && !existingIds.has(id)) {
      errors.push("地图 id 不存在：" + id);
    }
  }
  return errors;
}

async function submitMapProposalHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  operations: MapProposalOperation[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    // A validated generator draft can contain a self-contained SVG preview
    // plus thousands of structured features. Keep the 64 KiB limit on the
    // Agent-facing incremental tool, but allow the persisted draft to enter
    // review under the map document budget.
    assertMapProposalPayload(args.operations);
    const { workspace, context } = requireWorkspace();
    const errors = await validateMapDraftPayload(args.operations);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const proposalId =
      args.proposalId?.trim() || "map-proposal-" + randomUUID().slice(0, 8);
    if (!ID_PATTERN.test(proposalId)) {
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    }
    proposalDirectory = workspaceFile(
      workspace,
      MAP_PROPOSAL_ROOT + "/" + proposalId,
    );
    if (await readOptional(join(proposalDirectory, "proposal.json"))) {
      return result({
        submitted: true,
        proposalId,
        recovered: true,
        reviewAction: "请作者在小说工作台的世界地图中审阅并采纳候选。",
      });
    }
    await fs.mkdir(proposalDirectory, { recursive: true });
    createdProposalDirectory = true;
    const candidateDirectory = join(proposalDirectory, "candidates");
    const assetDirectory = join(proposalDirectory, "assets");
    await fs.mkdir(candidateDirectory, { recursive: true });
    const operations: Array<{
      candidateId: string;
      kind: "map";
      action: "create" | "update";
      targetId?: string;
      summary: string;
      valuePath: string;
      status: "pending";
    }> = [];
    for (const operation of args.operations) {
      const value = structuredClone(operation.value);
      const canvas = objectValue(value.canvas, "地图画布");
      const backgroundImage = canvas.backgroundImage;
      if (
        typeof backgroundImage === "string" &&
        backgroundImage.startsWith("data:image/svg+xml;base64,")
      ) {
        const svg = Buffer.from(
          backgroundImage.slice("data:image/svg+xml;base64,".length),
          "base64",
        ).toString("utf8");
        if (!/<svg[\s>]/iu.test(svg))
          throw new Error("地图候选内嵌的 SVG 底图无效");
        await fs.mkdir(assetDirectory, { recursive: true });
        await fs.writeFile(
          join(assetDirectory, `${operation.candidateId}.svg`),
          svg,
          {
            encoding: "utf8",
            flag: "wx",
          },
        );
        canvas.backgroundImage = null;
        canvas.backgroundAssetPath = `${MAP_PROPOSAL_ROOT}/${proposalId}/assets/${operation.candidateId}.svg`;
      }
      const valuePath = `candidates/${operation.candidateId}.json`;
      const candidateContent = JSON.stringify(value, null, 2) + "\n";
      if (Buffer.byteLength(candidateContent, "utf8") > MAX_CHANGE_BYTES) {
        throw new Error(
          `地图候选 ${operation.candidateId} 拆分底图后仍超过 2 MiB，请减少结构化要素`,
        );
      }
      await fs.writeFile(join(proposalDirectory, valuePath), candidateContent, {
        encoding: "utf8",
        flag: "wx",
      });
      operations.push({
        candidateId: operation.candidateId,
        kind: operation.kind,
        action: operation.action,
        ...(operation.targetId ? { targetId: operation.targetId } : {}),
        summary: operation.summary.trim(),
        valuePath,
        status: "pending",
      });
    }
    const manifest = {
      schemaVersion: 2,
      proposalId,
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent",
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      operations,
    };
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    return result({
      submitted: true,
      proposalId,
      operationCount: manifest.operations.length,
      reviewAction: "请作者在小说工作台的世界地图中审阅并采纳候选。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

type MapDraftPayload = {
  title: string;
  description: string;
  operations: MapProposalOperation[];
};

type FantasyMapGenerateArgs = {
  draftId?: string;
  title?: string;
  description?: string;
  seed?: string;
  mapName?: string;
  width?: number;
  height?: number;
  layerId?: string;
  landmassCount: number;
  regionCount: number;
  riverCount: number;
  worldNodeId?: string;
  generationLevelTypeId?: string;
  worldSourceHash: string;
  azgaarTemplate: string;
  azgaarStates: number;
  azgaarCultures: number;
  azgaarReligions: number;
  azgaarTemperatureEquator?: number;
  azgaarTemperatureNorthPole?: number;
  azgaarTemperatureSouthPole?: number;
  azgaarPrecipitation: number;
};

type FantasyMapScope = {
  readonly nodeId: string | null;
  readonly nodeIds: ReadonlySet<string>;
  readonly nodeName: string;
  readonly nodePath: string;
  readonly generationLevelTypeId: string | null;
  readonly generationLevelName: string | null;
  readonly generationMapKind: string | null;
};

type AzgaarGenerationPlan = {
  readonly heightmapTemplate: string;
  readonly landmassCount: number;
  readonly regionCount: number;
  readonly riverCount: number;
  readonly states: number;
  readonly cultures: number;
  readonly religions: number;
  readonly precipitation: number;
  readonly temperatureEquator?: number;
  readonly temperatureNorthPole?: number;
  readonly temperatureSouthPole?: number;
};

const AZGAAR_HEIGHTMAP_TEMPLATES = [
  "africa-centric",
  "arabia",
  "atlantics",
  "britain",
  "caribbean",
  "east-asia",
  "eurasia",
  "europe-accented",
  "europe-and-central-asia",
  "europe-central",
  "europe-north",
  "europe",
  "greenland",
  "hellenica",
  "iceland",
  "indian-ocean",
  "mediterranean-sea",
  "middle-east",
  "north-america",
  "us-centric",
  "us-mainland",
  "world-from-pacific",
  "world",
] as const;

const FANTASY_MAP_GENERATION_KINDS = new Set([
  "planet-point",
  "geographic-area",
  "settlement-point",
]);

function textList(value: unknown, fields: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim()];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    for (const field of fields) {
      if (typeof record[field] === "string" && record[field].trim()) {
        return [record[field].trim()];
      }
    }
    return [];
  });
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function resolveFantasyMapScope(
  files: Record<string, string | null>,
  args: FantasyMapGenerateArgs,
): FantasyMapScope {
  const metaPath = `${LIBRARY_ROOT}/meta.json`;
  const treePath = `${LIBRARY_ROOT}/spatial-tree.json`;
  const parseRecord = (path: string): Record<string, unknown> => {
    const content = files[path];
    if (!content) throw new Error(`地图生成缺少世界架构文件：${path}`);
    try {
      const value = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("根节点必须是对象");
      }
      return value as Record<string, unknown>;
    } catch (error) {
      throw new Error(`地图生成无法解析 ${path}：${message(error)}`);
    }
  };
  const meta = parseRecord(metaPath);
  const tree = parseRecord(treePath);
  const levelTypes = recordList(meta.levelTypes).filter(
    (type): type is Record<string, unknown> & { id: string; name: string } =>
      typeof type.id === "string" && typeof type.name === "string",
  );
  const nodes = recordList(tree.nodes).filter(
    (
      node,
    ): node is Record<string, unknown> & {
      id: string;
      name: string;
      parentId: string | null;
    } =>
      typeof node.id === "string" &&
      typeof node.name === "string" &&
      (typeof node.parentId === "string" || node.parentId === null),
  );
  if (args.worldNodeId && nodes.length === 0) {
    throw new Error("世界架构空间树没有可用节点");
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const selectedNode = args.worldNodeId
    ? nodesById.get(args.worldNodeId)
    : null;
  if (args.worldNodeId && !selectedNode) {
    throw new Error(`选定的世界架构范围不存在：${args.worldNodeId}`);
  }
  const nodeIds = new Set<string>();
  if (selectedNode) {
    const childrenByParent = new Map<string, string[]>();
    nodes.forEach((node) => {
      if (node.parentId === null) return;
      const children = childrenByParent.get(node.parentId) ?? [];
      children.push(node.id);
      childrenByParent.set(node.parentId, children);
    });
    const pending = [selectedNode.id];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (nodeIds.has(nodeId)) continue;
      nodeIds.add(nodeId);
      pending.push(...(childrenByParent.get(nodeId) ?? []));
    }
  } else {
    nodes.forEach((node) => nodeIds.add(node.id));
  }
  const pathParts: string[] = [];
  const visited = new Set<string>();
  let current = selectedNode ?? null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    pathParts.unshift(current.name);
    current = current.parentId
      ? (nodesById.get(current.parentId) ?? null)
      : null;
  }
  const selectedLevel = args.generationLevelTypeId
    ? levelTypes.find((type) => type.id === args.generationLevelTypeId)
    : undefined;
  if (args.generationLevelTypeId && !selectedLevel) {
    throw new Error(`选定的地图生成层级不存在：${args.generationLevelTypeId}`);
  }
  const generationMapKind =
    selectedLevel && typeof selectedLevel.mapKind === "string"
      ? selectedLevel.mapKind
      : null;
  if (
    generationMapKind !== null &&
    !FANTASY_MAP_GENERATION_KINDS.has(generationMapKind)
  ) {
    throw new Error("地图生成层级必须是行星、地理区域或聚落层级");
  }
  return {
    nodeId: selectedNode?.id ?? null,
    nodeIds,
    nodeName: selectedNode?.name ?? "整个世界架构",
    nodePath: pathParts.join(" / ") || "整个世界架构",
    generationLevelTypeId: selectedLevel?.id ?? null,
    generationLevelName: selectedLevel?.name ?? null,
    generationMapKind,
  };
}

function mapSlug(value: string): string {
  return (
    value
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32) || "world"
  );
}

const TERRAIN_CONTEXT_PATTERN =
  /山脉|山峰|森林|林地|草原|沙漠|荒漠|旱地|赤地|红土|峡谷|冻土|苔原|冰原|雪原|冰川|雪岭|冰封|沼泽|湿地|泥沼|火山|熔岩|岩浆|河流|湖泊|海洋|岛屿|desert|arid|badlands|canyon|tundra|snow|glacier|ice|swamp|wetland|marsh|volcanic|lava|forest|woodland/giu;

function extractTerrainKeywords(content: string): string[] {
  const matches = content.match(TERRAIN_CONTEXT_PATTERN) ?? [];
  const legacyMatches =
    content.match(/[山峰岭森林草原沙漠河流湖泊海洋岛屿湿地冰原]{1,4}/gu) ?? [];
  return [...matches, ...legacyMatches];
}

function collectSettingContext(
  files: Record<string, string | null>,
  scope?: FantasyMapScope,
): {
  spatialNames: string[];
  placeNames: string[];
  factionNames: string[];
  terrainKeywords: string[];
  sourceHash: string;
  fileCount: number;
} {
  const spatialNames: string[] = [];
  const placeNames: string[] = [];
  const factionNames: string[] = [];
  const terrainKeywords: string[] = [];
  const scopedSettingPaths = new Set<string>();
  if (scope) {
    const settingsContent = files[`${LIBRARY_ROOT}/settings.json`];
    if (settingsContent) {
      try {
        const settings = JSON.parse(settingsContent) as Record<string, unknown>;
        recordList(settings.settings)
          .filter(
            (setting) =>
              typeof setting.nodeId === "string" &&
              scope.nodeIds.has(setting.nodeId),
          )
          .forEach((setting) => {
            for (const key of ["pagePath", "entriesPath"] as const) {
              if (typeof setting[key] === "string") {
                scopedSettingPaths.add(setting[key]);
              }
            }
          });
      } catch {
        // 格式异常仍交给世界架构读取工具和草稿校验报告；本工具只使用可读部分。
      }
    }
  }
  for (const [path, content] of Object.entries(files)) {
    if (!content) continue;
    if (
      scope &&
      (path.startsWith(`${LIBRARY_ROOT}/pages/`) ||
        path.startsWith(`${LIBRARY_ROOT}/entries/`)) &&
      !scopedSettingPaths.has(path)
    ) {
      continue;
    }
    terrainKeywords.push(...extractTerrainKeywords(content));
    let value: unknown = null;
    try {
      value = JSON.parse(content);
    } catch {
      const headings = [...content.matchAll(/^#{1,3}\s+(.+)$/gmu)].map(
        (match) => match[1]?.trim(),
      );
      terrainKeywords.push(
        ...headings.filter((heading): heading is string => Boolean(heading)),
      );
      const namedPlaces = [
        ...content.matchAll(
          /([\p{Script=Han}]{2,16})(?:城|关|镇|港|山|河|湖|海|岛|原|谷)/gu,
        ),
      ].map((match) => match[1]?.trim());
      placeNames.push(
        ...namedPlaces.filter((name): name is string => Boolean(name)),
      );
      continue;
    }
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    if (path.endsWith("spatial-tree.json")) {
      const nodes = scope
        ? recordList(record.nodes).filter(
            (node) => typeof node.id === "string" && scope.nodeIds.has(node.id),
          )
        : record.nodes;
      spatialNames.push(...textList(nodes, ["name", "title"]));
    }
    if (path.endsWith("settings.json")) {
      const settings = recordList(record.settings).filter(
        (setting) =>
          !scope ||
          (typeof setting.nodeId === "string" &&
            scope.nodeIds.has(setting.nodeId)),
      );
      placeNames.push(
        ...settings.flatMap((setting) =>
          typeof setting.name === "string" ? [setting.name] : [],
        ),
      );
    }
    if (path.includes("locations/index.json"))
      placeNames.push(...textList(record.locations, ["name", "title"]));
    if (path.includes("factions"))
      factionNames.push(...textList(record.factions, ["name", "title"]));
    const serialized = JSON.stringify(value);
    terrainKeywords.push(...extractTerrainKeywords(serialized));
  }
  return {
    spatialNames: [...new Set(spatialNames)],
    placeNames: [...new Set(placeNames)],
    factionNames: [...new Set(factionNames)],
    terrainKeywords: [...new Set(terrainKeywords)],
    sourceHash: hashNovelWorkbenchDraftPayload(files),
    fileCount: Object.keys(files).length,
  };
}

/**
 * Azgaar cannot accept an arbitrary coast-outline count. The Agent therefore
 * selects a native heightmap template and the remaining native controls after
 * reading saved world facts; this records the mapping for audit and review.
 */
function deriveAzgaarGenerationPlan(
  args: FantasyMapGenerateArgs,
): AzgaarGenerationPlan {
  return {
    heightmapTemplate: args.azgaarTemplate,
    landmassCount: args.landmassCount,
    regionCount: args.regionCount,
    riverCount: args.riverCount,
    states: args.azgaarStates,
    cultures: args.azgaarCultures,
    religions: args.azgaarReligions,
    precipitation: args.azgaarPrecipitation,
    ...(args.azgaarTemperatureEquator === undefined
      ? {}
      : { temperatureEquator: args.azgaarTemperatureEquator }),
    ...(args.azgaarTemperatureNorthPole === undefined
      ? {}
      : { temperatureNorthPole: args.azgaarTemperatureNorthPole }),
    ...(args.azgaarTemperatureSouthPole === undefined
      ? {}
      : { temperatureSouthPole: args.azgaarTemperatureSouthPole }),
  };
}

async function generateFantasyMapHandler(
  args: FantasyMapGenerateArgs,
): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("maps");
    const basePaths = [
      `${LIBRARY_ROOT}/meta.json`,
      `${LIBRARY_ROOT}/spatial-tree.json`,
      `${LIBRARY_ROOT}/settings.json`,
      LOCATION_LIBRARY_PATH,
      FACTION_LIBRARY_PATH,
    ];
    const paths = new Set<string>(basePaths);
    const files: Record<string, string | null> = {};
    const readPath = async (path: string) => {
      if (path === LOCATION_LIBRARY_PATH) {
        files[path] =
          (await loadLocationSource(workspace))?.aggregateContent ?? null;
      } else if (path === FACTION_LIBRARY_PATH) {
        const source = await loadFactionSource(workspace).catch(() => null);
        files[path] = source
          ? `${JSON.stringify(source.library, null, 2)}\n`
          : null;
      } else {
        files[path] = await readOptional(workspaceFile(workspace, path));
      }
    };
    for (const path of paths) await readPath(path);
    const settingsContent = files[`${LIBRARY_ROOT}/settings.json`];
    if (settingsContent) {
      try {
        const settings = JSON.parse(settingsContent) as {
          settings?: unknown[];
        };
        for (const setting of recordList(settings.settings)) {
          for (const key of ["pagePath", "entriesPath"] as const) {
            const path = setting[key];
            if (
              typeof path === "string" &&
              SETTING_FILE_PATTERNS[
                key === "pagePath" ? "pagePath" : "entriesPath"
              ].test(path)
            ) {
              paths.add(path);
            }
          }
        }
      } catch {
        // The existing world context validator reports malformed settings. The
        // generator can still use the readable portions of the architecture.
      }
    }
    for (const path of paths) {
      if (!(path in files)) await readPath(path);
    }
    const scope = resolveFantasyMapScope(files, args);
    const settingContext = collectSettingContext(files, scope);
    const worldSourceHash = settingContext.sourceHash;
    if (args.worldSourceHash !== worldSourceHash) {
      throw new Error(
        `世界架构正文或词条在生成前已发生变化（sourceHash ${args.worldSourceHash} → ${worldSourceHash}），请重新调用 novel_world_get_context 并传入新的 sourceHash。`,
      );
    }
    const generationPlan = deriveAzgaarGenerationPlan(args);
    const width = Math.max(
      240,
      Math.min(100_000, Math.round(args.width ?? 1600)),
    );
    const height = Math.max(
      240,
      Math.min(100_000, Math.round(args.height ?? 1000)),
    );
    const seed =
      args.seed?.trim() ||
      `${context.promptId}-${settingContext.sourceHash.slice(0, 10)}`;
    let generator = "fantasy-map-compatibility-adapter";
    let generatedFeatures: readonly (AzgaarMapFeature | FantasyFeature)[] = [];
    let generatedSummary = "";
    let generatedTitle = "世界地图候选";
    let generatedBackgroundImage: string | null = null;
    let runtimeFailure: string | null = null;
    const useCompatibilityCandidate = (reason: string) => {
      const generated = generateFantasyMapCandidate({
        seed,
        width,
        height,
        layerId: args.layerId?.trim() || "layer-main",
        landmassCount: generationPlan.landmassCount,
        regionCount: generationPlan.regionCount,
        riverCount: generationPlan.riverCount,
        ...settingContext,
      });
      generator = "fantasy-map-compatibility-adapter";
      generatedFeatures = generated.features;
      generatedTitle = generated.title;
      generatedBackgroundImage = null;
      generatedSummary = `${generated.summary} ${reason}`;
    };
    if (azgaarRuntimeConfigured()) {
      try {
        const runtime = createAzgaarRuntimeClient();
        let exported;
        try {
          exported = await runtime.generate({
            seed,
            width,
            height,
            world: {
              sourceHash: settingContext.sourceHash,
              files,
              summary: `${args.mapName?.trim() || "小说工作台世界地图"} · ${scope.nodePath}${scope.generationLevelName ? ` · ${scope.generationLevelName}` : ""}`,
              constraints: {
                spatialNames: settingContext.spatialNames,
                placeNames: settingContext.placeNames,
                factionNames: settingContext.factionNames,
                terrainKeywords: settingContext.terrainKeywords,
              },
            },
            options: {
              heightmapTemplate: generationPlan.heightmapTemplate,
              states: generationPlan.states,
              cultures: generationPlan.cultures,
              religions: generationPlan.religions,
              precipitation: generationPlan.precipitation,
              ...(generationPlan.temperatureEquator === undefined
                ? {}
                : { temperatureEquator: generationPlan.temperatureEquator }),
              ...(generationPlan.temperatureNorthPole === undefined
                ? {}
                : {
                    temperatureNorthPole: generationPlan.temperatureNorthPole,
                  }),
              ...(generationPlan.temperatureSouthPole === undefined
                ? {}
                : {
                    temperatureSouthPole: generationPlan.temperatureSouthPole,
                  }),
            },
          });
        } finally {
          await runtime.dispose?.().catch(() => {});
        }
        if (exported.format === "svg") {
          if (!/<svg[\s>]/iu.test(exported.content))
            throw new Error("Azgaar Runtime 返回的 SVG 无效");
          generatedFeatures = [];
          generatedBackgroundImage = `data:image/svg+xml;base64,${Buffer.from(exported.content, "utf8").toString("base64")}`;
          generatedSummary =
            "已调用独立 Azgaar Runtime，SVG 作为不可破坏底图候选进入草稿。";
        } else {
          let exportedValue: unknown;
          try {
            exportedValue = JSON.parse(exported.content);
          } catch (error) {
            throw new Error(
              `Azgaar Runtime ${exported.format} 导出不是有效 JSON：${message(error)}`,
            );
          }
          const convertedFeatures = convertAzgaarExportToFeatures({
            value: exportedValue,
            width,
            height,
            layerId: args.layerId?.trim() || "layer-main",
          });
          if (convertedFeatures.length === 0)
            throw new Error("Azgaar Runtime 导出未包含可转换的地图要素");
          const editableSelection = selectAzgaarMapDocumentFeatures({
            features: convertedFeatures,
            preserveNames: [
              ...settingContext.spatialNames,
              ...settingContext.factionNames,
              ...settingContext.placeNames,
            ],
          });
          generatedFeatures = editableSelection.features;
          if (exported.previewSvg && /<svg[\s>]/iu.test(exported.previewSvg)) {
            generatedBackgroundImage = `data:image/svg+xml;base64,${Buffer.from(exported.previewSvg, "utf8").toString("base64")}`;
          }
          generatedSummary = `已调用独立 Azgaar Runtime，从 Full JSON 转换 ${editableSelection.sourceCount} 个官方要素；保留 ${generatedFeatures.length} 个可编辑对象，${editableSelection.omittedCount} 个细节保留在 SVG 底图中。`;
        }
        generator = runtime.id;
        generatedTitle = `${args.mapName?.trim() || "Azgaar 世界地图"}`;
      } catch (error) {
        runtimeFailure = message(error);
        useCompatibilityCandidate(
          `Azgaar Runtime 调用失败（${runtimeFailure}），已自动降级为设定驱动兼容候选。`,
        );
      }
    } else {
      useCompatibilityCandidate(
        "当前未配置独立 Azgaar Runtime，使用设定驱动兼容候选。",
      );
    }
    const requestedLayerId = args.layerId?.trim() || "layer-main";
    const hasAzgaarEditableOverlay = generatedFeatures.some(
      (feature) => typeof feature.props.azgaarLayer === "string",
    );
    const azgaarOverlayLayerId = "layer-azgaar-boundaries";
    const authorLayerId =
      hasAzgaarEditableOverlay && requestedLayerId === azgaarOverlayLayerId
        ? "layer-main"
        : requestedLayerId;
    const features = hasAzgaarEditableOverlay
      ? generatedFeatures.map((feature) => ({
          ...feature,
          layerId: azgaarOverlayLayerId,
        }))
      : generatedFeatures;
    const layers = hasAzgaarEditableOverlay
      ? [
          {
            id: authorLayerId,
            name: "作者要素",
            visible: true,
            locked: false,
            opacity: 1,
          },
          {
            id: azgaarOverlayLayerId,
            name: "Azgaar 可编辑边界",
            visible: true,
            locked: false,
            opacity: 1,
          },
        ]
      : [
          {
            id: requestedLayerId,
            name: "Fantasy Map 地形",
            visible: true,
            locked: false,
            opacity: 1,
          },
        ];
    const value = {
      id: `map-${mapSlug(args.mapName || generatedTitle)}-${settingContext.sourceHash.slice(0, 8)}`,
      name: args.mapName?.trim() || generatedTitle,
      projectionType:
        scope.generationMapKind === "planet-point" ? "planet" : "continent",
      canvas: {
        width,
        height,
        backgroundColor: "#9bb9c4",
        backgroundImage: generatedBackgroundImage,
        backgroundOpacity: 1,
        ...(generatedBackgroundImage
          ? {
              backgroundImageWidth: width,
              backgroundImageHeight: height,
            }
          : {}),
        showGrid: false,
      },
      layers,
      features,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const draft = await createNovelWorkbenchDraft<MapDraftPayload>(
      workspace,
      "maps",
      draftSource(context),
      {
        title: args.title?.trim() || `${value.name} · Fantasy Map 候选`,
        description: `${args.description?.trim() ?? ""}\n生成范围：${scope.nodePath}${scope.generationLevelName ? `；生成层级：${scope.generationLevelName}` : ""}。已读取世界架构 ${settingContext.fileCount} 个事实文件，sourceHash=${settingContext.sourceHash}。生成方案：高度图 ${generationPlan.heightmapTemplate}，${generationPlan.landmassCount} 个陆块意图、${generationPlan.regionCount} 个区域、${generationPlan.riverCount} 条河流意图；Azgaar 国家 ${generationPlan.states}、文化 ${generationPlan.cultures}、宗教 ${generationPlan.religions}、降水 ${generationPlan.precipitation}。`,
        operations: [
          {
            candidateId: `fantasy-${settingContext.sourceHash.slice(0, 12)}`,
            kind: "map",
            action: "create",
            summary: generatedSummary,
            value,
          },
        ],
      },
      args.draftId,
    );
    const response = {
      ...summarizeNovelWorkbenchDraft(draft),
      sourceHash: settingContext.sourceHash,
      worldSourceHash,
      contextFiles: settingContext.fileCount,
      generationPlan,
      scope: {
        worldNodeId: scope.nodeId,
        worldNodeName: scope.nodeName,
        worldNodePath: scope.nodePath,
        generationLevelTypeId: scope.generationLevelTypeId,
        generationLevelName: scope.generationLevelName,
      },
      generator: "fantasy-map-tool",
      generatorAdapter: generator,
      runtime:
        generator === "fantasy-map-compatibility-adapter"
          ? "compatibility-adapter"
          : "azgaar-http",
      ...(runtimeFailure ? { runtimeError: runtimeFailure } : {}),
      next: "调用 novel_maps_validate_draft，再用返回的 validationToken 调用 novel_maps_submit_draft；作者随后在地图提案审阅中确认。",
    };
    return result(response);
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function createMapDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("maps");
    const draft = await createNovelWorkbenchDraft<MapDraftPayload>(
      workspace,
      "maps",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        operations: [],
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getMapDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("maps");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<MapDraftPayload>(
          workspace,
          "maps",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertMapDraftOperationsHandler(args: {
  draftId: string;
  operations: MapProposalOperation[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.operations, "地图候选");
    const { workspace } = requireDraftMode("maps");
    const draft = await updateNovelWorkbenchDraft<MapDraftPayload>(
      workspace,
      "maps",
      args.draftId,
      (payload) => {
        const operations = new Map(
          payload.operations.map((operation) => [
            operation.candidateId,
            operation,
          ]),
        );
        for (const operation of args.operations) {
          const previous = operations.get(operation.candidateId);
          operations.set(
            operation.candidateId,
            previous
              ? {
                  ...operation,
                  value: mergeRecord(previous.value, operation.value),
                }
              : operation,
          );
        }
        return { ...payload, operations: [...operations.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateMapDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("maps");
    const draft = await loadNovelWorkbenchDraft<MapDraftPayload>(
      workspace,
      "maps",
      args.draftId,
    );
    const errors = await validateMapDraftPayload(draft.payload.operations);
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(draft.payload),
    );
    return result({
      valid: true,
      ...summarizeNovelWorkbenchDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitMapDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("maps");
    const draft = await loadNovelWorkbenchDraft<MapDraftPayload>(
      workspace,
      "maps",
      args.draftId,
    );
    const hash = hashNovelWorkbenchDraftPayload(draft.payload);
    if (draft.submittedProposalId) {
      return result(
        await getProposalStatus(
          MAP_PROPOSAL_ROOT,
          draft.submittedProposalId,
          "operations",
        ),
      );
    }
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !== hash
    ) {
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    }
    const proposalId = "maps-" + draft.draftId;
    const submitted = await submitMapProposalHandler({
      proposalId,
      ...draft.payload,
    });
    if (submitted.isError) return submitted;
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    return result({ ...decodeToolResult(submitted), draftId: draft.draftId });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getMapProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    requireDraftMode("maps");
    return result(
      await getProposalStatus(MAP_PROPOSAL_ROOT, args.proposalId, "operations"),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

type NarrativeContextScope =
  | "overview"
  | "lines"
  | "arcs"
  | "outline"
  | "chapters"
  | "all";

function filterNarrativeRecords(
  records: unknown[],
  ids: ReadonlySet<string>,
): unknown[] {
  if (ids.size === 0) return records;
  return records.filter((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return false;
    }
    const id = (record as Record<string, unknown>).id;
    return typeof id === "string" && ids.has(id);
  });
}

async function loadNarrativeSourceFromWorkspace(workspace: string): Promise<{
  content: string;
  library: Record<string, unknown>;
  files: ReadonlyMap<string, string>;
}> {
  const loaded = await loadNarrativeEngineeringFiles(async (path) =>
    fs.readFile(workspaceFile(workspace, path), "utf8"),
  );
  const library = narrativeRecord(loaded.library as unknown, "剧情工程事实源");
  narrativeRecords(library, "lines");
  narrativeRecords(library, "arcs");
  narrativeRecords(library, "directories");
  narrativeRecords(library, "chapters");
  return {
    content: serializeNarrativeFileSnapshot(loaded.files),
    library,
    files: loaded.files,
  };
}

async function getNarrativeContextHandler(args: {
  scope?: NarrativeContextScope;
  ids?: string[];
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const { content, library } =
      await loadNarrativeSourceFromWorkspace(workspace);
    const lines = arrayField(library, "lines");
    const arcs = arrayField(library, "arcs");
    const directories = arrayField(library, "directories");
    const chapters = arrayField(library, "chapters");
    if (!lines || !arcs || !directories || !chapters) {
      throw new Error("剧情工程事实源缺少线路、故事弧、目录或章节数组");
    }

    const scope = args.scope ?? "overview";
    const ids = new Set(args.ids ?? []);
    const overview = {
      schemaVersion: library.schemaVersion,
      updatedAt: library.updatedAt,
      counts: {
        lines: lines.length,
        arcs: arcs.length,
        directories: directories.length,
        chapters: chapters.length,
        sections: chapters.reduce<number>((total, chapter) => {
          const sections = arrayField(chapter, "sections");
          return total + (sections?.length ?? 0);
        }, 0),
      },
      lines: lines.map((line) => {
        const value = line as Record<string, unknown>;
        return {
          id: value.id,
          title: value.title,
          kind: value.kind,
          storyRole: value.storyRole,
          status: value.status,
        };
      }),
      arcs: arcs.map((arc) => {
        const value = arc as Record<string, unknown>;
        return {
          id: value.id,
          title: value.title,
          kind: value.kind,
          characterId: value.characterId,
          lineIds: value.lineIds,
        };
      }),
      directories: directories.map((directory) => {
        const value = directory as Record<string, unknown>;
        return {
          id: value.id,
          parentId: value.parentId,
          kind: value.kind,
          title: value.title,
          order: value.order,
        };
      }),
      chapters: chapters.map((chapter) => {
        const value = chapter as Record<string, unknown>;
        return {
          id: value.id,
          title: value.title,
          directoryId: value.directoryId,
          order: value.order,
          lineIds: value.lineIds,
          arcIds: value.arcIds,
          sectionCount: arrayField(chapter, "sections")?.length ?? 0,
        };
      }),
    };

    const data =
      scope === "lines"
        ? { lines: filterNarrativeRecords(lines, ids) }
        : scope === "arcs"
          ? { arcs: filterNarrativeRecords(arcs, ids) }
          : scope === "outline"
            ? { directories: filterNarrativeRecords(directories, ids) }
            : scope === "chapters"
              ? { chapters: filterNarrativeRecords(chapters, ids) }
              : scope === "all"
                ? library
                : overview;

    return result({
      mode: context.mode,
      sourcePath: NARRATIVE_ENGINEERING_PATH,
      source: "saved-facts",
      sourceHash: narrativeSourceHash(content),
      scope,
      data,
      note: "工具只返回已保存事实，不包含工作台页面中尚未保存的草稿。",
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

type TimelineContextScope =
  | "overview"
  | "events"
  | "periods"
  | "branches"
  | "all";

function filterTimelineRecords(
  records: unknown[],
  ids: ReadonlySet<string>,
): unknown[] {
  if (ids.size === 0) return records;
  return records.filter((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return false;
    }
    const id = (record as Record<string, unknown>).id;
    return typeof id === "string" && ids.has(id);
  });
}

async function getTimelineContextHandler(args: {
  scope?: TimelineContextScope;
  ids?: string[];
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const source = await loadTimelineSource(workspace);
    const library = source.library as unknown as Record<string, unknown>;
    const calendars = arrayField(library, "calendars");
    const periods = arrayField(library, "periods");
    const views = arrayField(library, "views");
    const branches = arrayField(library, "branches");
    const events = arrayField(library, "events");
    if (!calendars || !periods || !views || !branches || !events) {
      throw new Error("时间线事实源缺少历法、纪元、视图、分支或事件数组");
    }

    const scope = args.scope ?? "overview";
    const ids = new Set(args.ids ?? []);
    const overview = {
      schemaVersion: library.schemaVersion,
      storyStartEventId: library.storyStartEventId ?? null,
      factsThroughEventId: library.factsThroughEventId ?? null,
      counts: {
        calendars: calendars.length,
        periods: periods.length,
        views: views.length,
        branches: branches.length,
        events: events.length,
        stateChanges: events.reduce<number>((total, event) => {
          const stateChanges = arrayField(event, "stateChanges");
          return total + (stateChanges?.length ?? 0);
        }, 0),
        foreshadowings: events.reduce<number>((total, event) => {
          const foreshadowings = arrayField(event, "foreshadowings");
          return total + (foreshadowings?.length ?? 0);
        }, 0),
      },
      calendars: calendars.map((calendar) => {
        const value = calendar as Record<string, unknown>;
        return { id: value.id, name: value.name, unit: value.unit };
      }),
      periods: periods.map((period) => {
        const value = period as Record<string, unknown>;
        return {
          id: value.id,
          name: value.name,
          parentPeriodId: value.parentPeriodId,
          kind: value.kind,
          scope: value.scope,
          startSortKey: value.startSortKey,
          endSortKey: value.endSortKey,
        };
      }),
      branches: branches.map((branch) => {
        const value = branch as Record<string, unknown>;
        return {
          id: value.id,
          name: value.name,
          parentBranchId: value.parentBranchId,
          forkEventId: value.forkEventId,
        };
      }),
      events: events.map((event) => {
        const value = event as Record<string, unknown>;
        return {
          id: value.id,
          branchId: value.branchId,
          timeLabel: value.timeLabel,
          sortKey: value.sortKey,
          endSortKey: value.endSortKey,
          periodId: value.periodId,
          scope: value.scope,
          narrativeOrder: value.narrativeOrder,
          title: value.title,
          kind: value.kind,
          causeEventIds: value.causeEventIds,
          chapterIds: value.chapterIds,
          stateChangeCount: arrayField(event, "stateChanges")?.length ?? 0,
          foreshadowingCount: arrayField(event, "foreshadowings")?.length ?? 0,
        };
      }),
    };
    const data =
      scope === "events"
        ? { events: filterTimelineRecords(events, ids) }
        : scope === "periods"
          ? { periods: filterTimelineRecords(periods, ids) }
          : scope === "branches"
            ? { branches: filterTimelineRecords(branches, ids) }
            : scope === "all"
              ? library
              : overview;

    return result({
      mode: context.mode,
      sourcePath: TIMELINE_LIBRARY_PATH,
      source: "saved-facts",
      sourceHash: createHash("sha256").update(source.snapshot).digest("hex"),
      scope,
      data,
      note: "工具返回的是已保存事实；会话初始消息中的当前页面草稿如有冲突，应以作者当前草稿为准。",
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

function narrativeSourceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function narrativeRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}格式错误`);
  }
  return value as Record<string, unknown>;
}

function narrativeRecords(
  library: Record<string, unknown>,
  key: "lines" | "arcs" | "directories" | "chapters",
): Record<string, unknown>[] {
  const records = arrayField(library, key);
  if (!records) throw new Error(`剧情工程事实源缺少${key}数组`);
  return records.map((record, index) =>
    narrativeRecord(record, `${key}[${index}]`),
  );
}

function narrativeString(
  record: Record<string, unknown> | undefined,
  field: string,
  fallback: string,
): string {
  const value = record?.[field];
  return typeof value === "string" ? value : fallback;
}

function narrativeNullableId(
  record: Record<string, unknown> | undefined,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

function narrativeIdList(
  record: Record<string, unknown> | undefined,
  field: string,
): string[] {
  return (arrayField(record, field) ?? []).filter(
    (value): value is string => typeof value === "string",
  );
}

function narrativeId(prefix: string, knownIds: ReadonlySet<string>): string {
  let id = "";
  do {
    id = `${prefix}-${randomUUID().slice(0, 8)}`;
  } while (knownIds.has(id));
  return id;
}

function narrativeKeyNodeErrors(
  nodes: readonly NarrativeKeyNodeInput[],
  library: Record<string, unknown>,
  label: string,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const chapters = narrativeRecords(library, "chapters");
  const chapterById = new Map(
    chapters.map((chapter) => [String(chapter.id), chapter]),
  );
  nodes.forEach((node, index) => {
    if (!ID_PATTERN.test(node.nodeId) || ids.has(node.nodeId))
      errors.push(`${label}[${index}] 的 nodeId 非法或重复`);
    ids.add(node.nodeId);
    if (!node.title.trim()) errors.push(`${label}[${index}] 缺少标题`);
    if (!node.content.trim()) errors.push(`${label}[${index}] 缺少内容`);
    for (const location of node.locations ?? []) {
      const chapter = chapterById.get(location.chapterId);
      if (!chapter) {
        errors.push(
          `${label}[${index}] 关联了不存在的章节：${location.chapterId}`,
        );
        continue;
      }
      if (
        location.sectionId &&
        !arrayField(chapter, "sections")?.some(
          (section) =>
            section &&
            typeof section === "object" &&
            !Array.isArray(section) &&
            (section as Record<string, unknown>).id === location.sectionId,
        )
      ) {
        errors.push(
          `${label}[${index}] 关联的节不属于章节：${location.sectionId}`,
        );
      }
    }
  });
  if (nodes.length === 0) errors.push(`${label} 至少需要一个关键节点`);
  return errors;
}

function validateNarrativeDraftPayload(
  payload: NarrativeDraftPayload,
  library: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const directoryInputs = payload.directories ?? [];
  const chapterInputs = payload.chapters ?? [];
  if (!payload.title.trim()) errors.push("剧情提案标题不能为空");
  const existingLineIds = new Set(
    narrativeRecords(library, "lines").map((line) => String(line.id)),
  );
  const existingArcIds = new Set(
    narrativeRecords(library, "arcs").map((arc) => String(arc.id)),
  );
  const existingDirectories = narrativeRecords(library, "directories");
  const existingDirectoryIds = new Set(
    existingDirectories.map((directory) => String(directory.id)),
  );
  const existingChapters = narrativeRecords(library, "chapters");
  const existingChaptersById = new Map(
    existingChapters.map((chapter) => [String(chapter.id), chapter]),
  );
  const candidateIds = new Set<string>();
  const targetLineIds = new Set<string>();
  const targetArcIds = new Set<string>();
  const targetDirectoryIds = new Set<string>();
  const targetChapterIds = new Set<string>();
  for (const [index, line] of payload.lines.entries()) {
    if (
      !ID_PATTERN.test(line.candidateId) ||
      candidateIds.has(line.candidateId)
    )
      errors.push(`线路候选 ${index + 1} 的 candidateId 非法或重复`);
    candidateIds.add(line.candidateId);
    if (!line.title.trim()) errors.push(`线路候选 ${index + 1} 缺少标题`);
    if (line.targetId) {
      if (!existingLineIds.has(line.targetId)) {
        errors.push(
          `线路候选 ${index + 1} 的 targetId 不存在：${line.targetId}`,
        );
      } else if (targetLineIds.has(line.targetId)) {
        errors.push(`多个线路候选不能更新同一条线路：${line.targetId}`);
      }
      targetLineIds.add(line.targetId);
    }
    errors.push(
      ...narrativeKeyNodeErrors(
        line.keyNodes,
        library,
        `线路候选 ${index + 1} 的关键节点`,
      ),
    );
  }
  for (const [index, arc] of payload.arcs.entries()) {
    if (!ID_PATTERN.test(arc.candidateId) || candidateIds.has(arc.candidateId))
      errors.push(`故事弧候选 ${index + 1} 的 candidateId 非法或重复`);
    candidateIds.add(arc.candidateId);
    if (!arc.title.trim()) errors.push(`故事弧候选 ${index + 1} 缺少标题`);
    if (arc.targetId) {
      if (!existingArcIds.has(arc.targetId)) {
        errors.push(
          `故事弧候选 ${index + 1} 的 targetId 不存在：${arc.targetId}`,
        );
      } else if (targetArcIds.has(arc.targetId)) {
        errors.push(`多个故事弧候选不能更新同一条故事弧：${arc.targetId}`);
      }
      targetArcIds.add(arc.targetId);
    }
    errors.push(
      ...narrativeKeyNodeErrors(
        arc.keyNodes,
        library,
        `故事弧候选 ${index + 1} 的关键节点`,
      ),
    );
  }
  const effectiveIdByCandidate = new Map<string, string>();
  for (const directory of directoryInputs) {
    effectiveIdByCandidate.set(
      directory.candidateId,
      directory.targetId ?? directory.candidateId,
    );
  }
  const effectiveDirectoryKinds = new Map(
    existingDirectories.map((directory) => [
      String(directory.id),
      narrativeString(directory, "kind", "group") as NarrativeDirectoryKind,
    ]),
  );
  const effectiveDirectoryParents = new Map<string, string | null>(
    existingDirectories.map((directory) => [
      String(directory.id),
      narrativeNullableId(directory, "parentId"),
    ]),
  );
  for (const [index, directory] of directoryInputs.entries()) {
    if (
      !ID_PATTERN.test(directory.candidateId) ||
      candidateIds.has(directory.candidateId)
    ) {
      errors.push(`目录候选 ${index + 1} 的 candidateId 非法或重复`);
    }
    candidateIds.add(directory.candidateId);
    if (!directory.title.trim()) {
      errors.push(`目录候选 ${index + 1} 缺少标题`);
    }
    if (directory.targetId) {
      if (!existingDirectoryIds.has(directory.targetId)) {
        errors.push(
          `目录候选 ${index + 1} 的 targetId 不存在：${directory.targetId}`,
        );
      } else if (targetDirectoryIds.has(directory.targetId)) {
        errors.push(`多个目录候选不能更新同一个目录：${directory.targetId}`);
      }
      targetDirectoryIds.add(directory.targetId);
    }
    const effectiveId = directory.targetId ?? directory.candidateId;
    const effectiveParentId = directory.parentId
      ? (effectiveIdByCandidate.get(directory.parentId) ?? directory.parentId)
      : null;
    effectiveDirectoryKinds.set(effectiveId, directory.kind);
    effectiveDirectoryParents.set(effectiveId, effectiveParentId);
  }
  for (const [index, directory] of directoryInputs.entries()) {
    const effectiveId = directory.targetId ?? directory.candidateId;
    const parentId = effectiveDirectoryParents.get(effectiveId) ?? null;
    const parentKind = parentId
      ? effectiveDirectoryKinds.get(parentId)
      : undefined;
    if (parentId && !effectiveDirectoryKinds.has(parentId)) {
      errors.push(
        `目录候选 ${index + 1} 引用了不存在的父目录：${directory.parentId}`,
      );
    }
    if (directory.kind === "volume" && parentId !== null) {
      errors.push(`卷目录“${directory.title}”必须位于根层`);
    }
    if (directory.kind === "part" && parentKind !== "volume") {
      errors.push(`篇目录“${directory.title}”必须归属于卷`);
    }
    if (
      !directory.targetId &&
      directory.kind === "group" &&
      parentId === null
    ) {
      errors.push(`新建组目录“${directory.title}”必须指定父目录`);
    }
    const visited = new Set([effectiveId]);
    let ancestorId = parentId;
    while (ancestorId) {
      if (visited.has(ancestorId)) {
        errors.push(`目录候选“${directory.title}”形成了循环引用`);
        break;
      }
      visited.add(ancestorId);
      ancestorId = effectiveDirectoryParents.get(ancestorId) ?? null;
    }
  }
  const allLineIds = new Set([
    ...existingLineIds,
    ...payload.lines.map((line) => line.candidateId),
  ]);
  payload.arcs.forEach((arc, index) => {
    const missing = [...new Set(arc.lineIds ?? [])].filter(
      (id) => !allLineIds.has(id),
    );
    if (missing.length > 0)
      errors.push(
        `故事弧候选 ${index + 1} 关联了不存在的线路：${missing.join(", ")}`,
      );
  });
  const allArcIds = new Set([
    ...existingArcIds,
    ...payload.arcs.map((arc) => arc.candidateId),
  ]);
  const allDirectoryIds = new Set([
    ...existingDirectoryIds,
    ...directoryInputs.map((directory) => directory.candidateId),
  ]);
  const referencedSectionsByChapter = new Map<string, Set<string>>();
  for (const owner of [
    ...narrativeRecords(library, "lines"),
    ...narrativeRecords(library, "arcs"),
  ]) {
    for (const node of arrayField(owner, "keyNodes") ?? []) {
      const nodeRecord = narrativeRecord(node, "关键节点");
      for (const location of arrayField(nodeRecord, "locations") ?? []) {
        const locationRecord = narrativeRecord(location, "关键节点关联位置");
        const chapterId = narrativeString(locationRecord, "chapterId", "");
        const sectionId = narrativeNullableId(locationRecord, "sectionId");
        if (!chapterId || !sectionId) continue;
        const referenced =
          referencedSectionsByChapter.get(chapterId) ?? new Set();
        referenced.add(sectionId);
        referencedSectionsByChapter.set(chapterId, referenced);
      }
    }
  }
  for (const [chapterIndex, chapter] of chapterInputs.entries()) {
    if (
      !ID_PATTERN.test(chapter.candidateId) ||
      candidateIds.has(chapter.candidateId)
    ) {
      errors.push(`章节候选 ${chapterIndex + 1} 的 candidateId 非法或重复`);
    }
    candidateIds.add(chapter.candidateId);
    if (!chapter.title.trim()) {
      errors.push(`章节候选 ${chapterIndex + 1} 缺少标题`);
    }
    const existingChapter = chapter.targetId
      ? existingChaptersById.get(chapter.targetId)
      : undefined;
    if (chapter.targetId) {
      if (!existingChapter) {
        errors.push(
          `章节候选 ${chapterIndex + 1} 的 targetId 不存在：${chapter.targetId}`,
        );
      } else if (targetChapterIds.has(chapter.targetId)) {
        errors.push(`多个章节候选不能更新同一章：${chapter.targetId}`);
      }
      targetChapterIds.add(chapter.targetId);
    }
    if (chapter.directoryId && !allDirectoryIds.has(chapter.directoryId)) {
      errors.push(
        `章节候选 ${chapterIndex + 1} 归属了不存在的目录：${chapter.directoryId}`,
      );
    }
    const missingLineIds = [...new Set(chapter.lineIds ?? [])].filter(
      (id) => !allLineIds.has(id),
    );
    if (missingLineIds.length > 0) {
      errors.push(
        `章节候选 ${chapterIndex + 1} 关联了不存在的线路：${missingLineIds.join(", ")}`,
      );
    }
    const missingArcIds = [...new Set(chapter.arcIds ?? [])].filter(
      (id) => !allArcIds.has(id),
    );
    if (missingArcIds.length > 0) {
      errors.push(
        `章节候选 ${chapterIndex + 1} 关联了不存在的故事弧：${missingArcIds.join(", ")}`,
      );
    }
    if (chapter.sections.length === 0) {
      errors.push(`章节候选 ${chapterIndex + 1} 至少需要一个节`);
    }
    const existingSections = new Map(
      (arrayField(existingChapter, "sections") ?? []).map((section) => {
        const record = narrativeRecord(section, "既有节");
        return [String(record.id), record] as const;
      }),
    );
    const retainedSectionIds = new Set<string>();
    const targetSectionIds = new Set<string>();
    for (const [sectionIndex, section] of chapter.sections.entries()) {
      if (
        !ID_PATTERN.test(section.candidateId) ||
        candidateIds.has(section.candidateId)
      ) {
        errors.push(
          `章节候选 ${chapterIndex + 1} 的第 ${sectionIndex + 1} 节 candidateId 非法或重复`,
        );
      }
      candidateIds.add(section.candidateId);
      if (!section.title.trim()) {
        errors.push(
          `章节候选 ${chapterIndex + 1} 的第 ${sectionIndex + 1} 节缺少标题`,
        );
      }
      const existingSection = section.targetId
        ? existingSections.get(section.targetId)
        : undefined;
      if (section.targetId) {
        if (!existingSection) {
          errors.push(
            `章节候选 ${chapterIndex + 1} 的节 targetId 不属于该章节：${section.targetId}`,
          );
        } else if (targetSectionIds.has(section.targetId)) {
          errors.push(
            `章节候选 ${chapterIndex + 1} 不能重复更新同一节：${section.targetId}`,
          );
        }
        targetSectionIds.add(section.targetId);
      }
      retainedSectionIds.add(section.targetId ?? section.candidateId);
      const sectionMissingLineIds = [...new Set(section.lineIds ?? [])].filter(
        (id) => !allLineIds.has(id),
      );
      const sectionMissingArcIds = [...new Set(section.arcIds ?? [])].filter(
        (id) => !allArcIds.has(id),
      );
      if (sectionMissingLineIds.length > 0) {
        errors.push(
          `章节候选 ${chapterIndex + 1} 的节“${section.title}”关联了不存在的线路：${sectionMissingLineIds.join(", ")}`,
        );
      }
      if (sectionMissingArcIds.length > 0) {
        errors.push(
          `章节候选 ${chapterIndex + 1} 的节“${section.title}”关联了不存在的故事弧：${sectionMissingArcIds.join(", ")}`,
        );
      }
      const existingParagraphs = new Set(
        (arrayField(existingSection, "paragraphs") ?? []).map((paragraph) =>
          String(narrativeRecord(paragraph, "既有段").id),
        ),
      );
      const targetParagraphIds = new Set<string>();
      for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
        if (
          !ID_PATTERN.test(paragraph.candidateId) ||
          candidateIds.has(paragraph.candidateId)
        ) {
          errors.push(
            `章节候选 ${chapterIndex + 1} 的第 ${sectionIndex + 1} 节第 ${paragraphIndex + 1} 段 candidateId 非法或重复`,
          );
        }
        candidateIds.add(paragraph.candidateId);
        if (paragraph.targetId) {
          if (!existingParagraphs.has(paragraph.targetId)) {
            errors.push(
              `章节候选 ${chapterIndex + 1} 的段 targetId 不属于该节：${paragraph.targetId}`,
            );
          } else if (targetParagraphIds.has(paragraph.targetId)) {
            errors.push(
              `章节候选 ${chapterIndex + 1} 的节“${section.title}”不能重复更新同一段：${paragraph.targetId}`,
            );
          }
          targetParagraphIds.add(paragraph.targetId);
        }
        if (!paragraph.content.trim()) {
          errors.push(
            `章节候选 ${chapterIndex + 1} 的第 ${sectionIndex + 1} 节第 ${paragraphIndex + 1} 段内容不能为空`,
          );
        }
      }
    }
    for (const referencedSectionId of chapter.targetId
      ? (referencedSectionsByChapter.get(chapter.targetId) ?? [])
      : []) {
      if (!retainedSectionIds.has(referencedSectionId)) {
        errors.push(
          `章节候选 ${chapterIndex + 1} 删除了仍被线路或故事弧关键节点关联的节：${referencedSectionId}`,
        );
      }
    }
  }
  if (
    payload.lines.length +
      payload.arcs.length +
      directoryInputs.length +
      chapterInputs.length ===
    0
  ) {
    errors.push("至少需要一条线路、一个故事弧、一个目录或一个章节候选");
  }
  return errors;
}

function materializeNarrativeDraft(
  payload: NarrativeDraftPayload,
  library: Record<string, unknown>,
): {
  lines: Record<string, unknown>[];
  arcs: Record<string, unknown>[];
  directories: Record<string, unknown>[];
  chapters: Record<string, unknown>[];
  updatedLineIds: readonly string[];
  updatedArcIds: readonly string[];
  updatedDirectoryIds: readonly string[];
  updatedChapterIds: readonly string[];
} {
  const directoryInputs = payload.directories ?? [];
  const chapterInputs = payload.chapters ?? [];
  const existingLines = narrativeRecords(library, "lines");
  const existingArcs = narrativeRecords(library, "arcs");
  const existingDirectories = narrativeRecords(library, "directories");
  const existingChapters = narrativeRecords(library, "chapters");
  const existingLinesById = new Map(
    existingLines.map((line) => [String(line.id), line]),
  );
  const existingArcsById = new Map(
    existingArcs.map((arc) => [String(arc.id), arc]),
  );
  const existingDirectoriesById = new Map(
    existingDirectories.map((directory) => [String(directory.id), directory]),
  );
  const existingChaptersById = new Map(
    existingChapters.map((chapter) => [String(chapter.id), chapter]),
  );
  const knownLineIds = new Set(existingLinesById.keys());
  const knownArcIds = new Set(existingArcsById.keys());
  const knownDirectoryIds = new Set(existingDirectoriesById.keys());
  const knownChapterIds = new Set(existingChaptersById.keys());
  const knownNestedIds = new Set<string>();
  for (const chapter of existingChapters) {
    for (const section of arrayField(chapter, "sections") ?? []) {
      const sectionRecord = narrativeRecord(section, "既有节");
      knownNestedIds.add(String(sectionRecord.id));
      for (const paragraph of arrayField(sectionRecord, "paragraphs") ?? []) {
        knownNestedIds.add(String(narrativeRecord(paragraph, "既有段").id));
      }
    }
  }
  const knownNodeIds = new Set<string>();
  for (const owner of [...existingLines, ...existingArcs]) {
    for (const node of arrayField(owner, "keyNodes") ?? []) {
      if (node && typeof node === "object" && !Array.isArray(node))
        knownNodeIds.add(String((node as Record<string, unknown>).id));
    }
  }
  const lineIds = new Map<string, string>();
  const updatedLineIds: string[] = [];
  const lines = payload.lines.map((input) => {
    const existing = input.targetId
      ? existingLinesById.get(input.targetId)
      : undefined;
    if (input.targetId && !existing) {
      throw new Error(`线路更新目标不存在：${input.targetId}`);
    }
    const id = input.targetId ?? narrativeId("line", knownLineIds);
    if (existing) updatedLineIds.push(id);
    else knownLineIds.add(id);
    lineIds.set(input.candidateId, id);
    const kind = input.kind ?? narrativeString(existing, "kind", "custom");
    return {
      id,
      title: input.title.trim(),
      kind,
      storyRole:
        input.storyRole ??
        narrativeString(existing, "storyRole", kind === "main" ? "a" : "none"),
      status: input.status ?? narrativeString(existing, "status", "idea"),
      color:
        input.kind === undefined
          ? narrativeString(
              existing,
              "color",
              NARRATIVE_LINE_COLORS[kind as NarrativeLineKind],
            )
          : NARRATIVE_LINE_COLORS[kind as NarrativeLineKind],
      premise:
        input.premise === undefined
          ? narrativeString(existing, "premise", "")
          : input.premise.trim(),
      protagonistCharacterId:
        input.protagonistCharacterId === undefined
          ? narrativeNullableId(existing, "protagonistCharacterId")
          : input.protagonistCharacterId,
      keyNodes: input.keyNodes.map((node, order) => ({
        id: narrativeId("node", knownNodeIds),
        title: node.title.trim(),
        content: node.content,
        order,
        locations: (node.locations ?? []).map((location) => ({
          id: narrativeId("location", knownNodeIds),
          chapterId: location.chapterId,
          sectionId: location.sectionId,
        })),
      })),
      content:
        input.content === undefined
          ? narrativeString(existing, "content", "")
          : input.content,
    };
  });
  const arcIds = new Map<string, string>();
  const updatedArcIds: string[] = [];
  const arcs = payload.arcs.map((input) => {
    const existing = input.targetId
      ? existingArcsById.get(input.targetId)
      : undefined;
    if (input.targetId && !existing) {
      throw new Error(`故事弧更新目标不存在：${input.targetId}`);
    }
    const id = input.targetId ?? narrativeId("arc", knownArcIds);
    if (existing) updatedArcIds.push(id);
    else knownArcIds.add(id);
    arcIds.set(input.candidateId, id);
    return {
      id,
      title: input.title.trim(),
      kind: input.kind ?? narrativeString(existing, "kind", "plot"),
      characterId:
        input.characterId === undefined
          ? narrativeNullableId(existing, "characterId")
          : input.characterId,
      characterArcStageId:
        input.characterArcStageId === undefined
          ? narrativeNullableId(existing, "characterArcStageId")
          : input.characterArcStageId,
      characterArcStageTitle:
        input.characterArcStageTitle === undefined
          ? narrativeString(existing, "characterArcStageTitle", "")
          : input.characterArcStageTitle.trim(),
      lineIds: [
        ...new Set(
          (input.lineIds ?? narrativeIdList(existing, "lineIds")).map(
            (lineId) => lineIds.get(lineId) ?? lineId,
          ),
        ),
      ],
      keyNodes: input.keyNodes.map((node, order) => ({
        id: narrativeId("node", knownNodeIds),
        title: node.title.trim(),
        content: node.content,
        order,
        locations: (node.locations ?? []).map((location) => ({
          id: narrativeId("location", knownNodeIds),
          chapterId: location.chapterId,
          sectionId: location.sectionId,
        })),
      })),
      content:
        input.content === undefined
          ? narrativeString(existing, "content", "")
          : input.content,
    };
  });
  const directoryIds = new Map<string, string>();
  const updatedDirectoryIds: string[] = [];
  for (const input of directoryInputs) {
    const existing = input.targetId
      ? existingDirectoriesById.get(input.targetId)
      : undefined;
    if (input.targetId && !existing) {
      throw new Error(`目录更新目标不存在：${input.targetId}`);
    }
    const id = input.targetId ?? narrativeId("directory", knownDirectoryIds);
    if (existing) updatedDirectoryIds.push(id);
    else knownDirectoryIds.add(id);
    directoryIds.set(input.candidateId, id);
  }
  const directories = directoryInputs.map((input) => {
    const existing = input.targetId
      ? existingDirectoriesById.get(input.targetId)
      : undefined;
    const id = directoryIds.get(input.candidateId);
    if (!id) throw new Error(`目录候选未分配稳定 ID：${input.candidateId}`);
    return {
      id,
      parentId:
        input.parentId === null
          ? null
          : (directoryIds.get(input.parentId) ?? input.parentId),
      kind: input.kind,
      title: input.title.trim(),
      description:
        input.description === undefined
          ? narrativeString(existing, "description", "")
          : input.description,
      status: input.status ?? narrativeString(existing, "status", "idea"),
      order: input.order,
    };
  });
  const chapterIds = new Map<string, string>();
  const updatedChapterIds: string[] = [];
  for (const input of chapterInputs) {
    const existing = input.targetId
      ? existingChaptersById.get(input.targetId)
      : undefined;
    if (input.targetId && !existing) {
      throw new Error(`章节更新目标不存在：${input.targetId}`);
    }
    const id = input.targetId ?? narrativeId("chapter", knownChapterIds);
    if (existing) updatedChapterIds.push(id);
    else knownChapterIds.add(id);
    chapterIds.set(input.candidateId, id);
  }
  const materializedAt = new Date().toISOString();
  const chapters = chapterInputs.map((input) => {
    const existing = input.targetId
      ? existingChaptersById.get(input.targetId)
      : undefined;
    const id = chapterIds.get(input.candidateId);
    if (!id) throw new Error(`章节候选未分配稳定 ID：${input.candidateId}`);
    const existingSectionsById = new Map(
      (arrayField(existing, "sections") ?? []).map((section) => {
        const value = narrativeRecord(section, "既有节");
        return [String(value.id), value] as const;
      }),
    );
    const sections = input.sections.map((section) => {
      const existingSection = section.targetId
        ? existingSectionsById.get(section.targetId)
        : undefined;
      const sectionId =
        section.targetId ?? narrativeId("section", knownNestedIds);
      if (!section.targetId) knownNestedIds.add(sectionId);
      const existingParagraphsById = new Map(
        (arrayField(existingSection, "paragraphs") ?? []).map((paragraph) => {
          const value = narrativeRecord(paragraph, "既有段");
          return [String(value.id), value] as const;
        }),
      );
      return {
        id: sectionId,
        order: section.order,
        title: section.title.trim(),
        description: section.description,
        povCharacterId:
          section.povCharacterId === undefined
            ? narrativeNullableId(existingSection, "povCharacterId")
            : section.povCharacterId,
        lineIds: [
          ...new Set(
            (
              section.lineIds ?? narrativeIdList(existingSection, "lineIds")
            ).map((lineId) => lineIds.get(lineId) ?? lineId),
          ),
        ],
        arcIds: [
          ...new Set(
            (section.arcIds ?? narrativeIdList(existingSection, "arcIds")).map(
              (arcId) => arcIds.get(arcId) ?? arcId,
            ),
          ),
        ],
        paragraphs: section.paragraphs.map((paragraph) => {
          const existingParagraph = paragraph.targetId
            ? existingParagraphsById.get(paragraph.targetId)
            : undefined;
          const paragraphId =
            paragraph.targetId ?? narrativeId("paragraph", knownNestedIds);
          if (!paragraph.targetId) knownNestedIds.add(paragraphId);
          return {
            id: paragraphId,
            order: paragraph.order,
            content:
              paragraph.content === undefined
                ? narrativeString(existingParagraph, "content", "")
                : paragraph.content,
          };
        }),
      };
    });
    return {
      id,
      directoryId:
        input.directoryId === null
          ? null
          : (directoryIds.get(input.directoryId) ?? input.directoryId),
      manuscriptChapterId: narrativeNullableId(existing, "manuscriptChapterId"),
      title: input.title.trim(),
      description: input.description,
      status: input.status ?? narrativeString(existing, "status", "idea"),
      order: input.order,
      updatedAt: materializedAt,
      lineIds: [
        ...new Set(
          (input.lineIds ?? narrativeIdList(existing, "lineIds")).map(
            (lineId) => lineIds.get(lineId) ?? lineId,
          ),
        ),
      ],
      arcIds: [
        ...new Set(
          (input.arcIds ?? narrativeIdList(existing, "arcIds")).map(
            (arcId) => arcIds.get(arcId) ?? arcId,
          ),
        ),
      ],
      sections,
    };
  });
  return {
    lines,
    arcs,
    directories,
    chapters,
    updatedLineIds,
    updatedArcIds,
    updatedDirectoryIds,
    updatedChapterIds,
  };
}

async function readNarrativeSource(): Promise<{
  workspace: string;
  content: string;
  library: Record<string, unknown>;
}> {
  const { workspace } = requireDraftMode("narrative");
  const { content, library } =
    await loadNarrativeSourceFromWorkspace(workspace);
  if (library.schemaVersion !== NARRATIVE_ENGINEERING_SCHEMA_VERSION) {
    throw new Error("剧情工程事实源版本无效");
  }
  return { workspace, content, library };
}

function narrativeProposalId(draftId: string): string {
  return `narrative-${draftId}`;
}

async function createNarrativeDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
  baseSourceHash: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("narrative");
    const draft = await createNovelWorkbenchDraft<NarrativeDraftPayload>(
      workspace,
      "narrative",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        baseSourceHash: args.baseSourceHash,
        lines: [],
        arcs: [],
        directories: [],
        chapters: [],
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getNarrativeDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("narrative");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<NarrativeDraftPayload>(
          workspace,
          "narrative",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

function mergeNarrativeKeyNodes(
  previous: readonly NarrativeKeyNodeInput[],
  next: readonly NarrativeKeyNodeInput[],
): NarrativeKeyNodeInput[] {
  const nodes = new Map(previous.map((node) => [node.nodeId, node]));
  for (const node of next) {
    const existing = nodes.get(node.nodeId);
    nodes.set(node.nodeId, existing ? { ...existing, ...node } : node);
  }
  return [...nodes.values()];
}

function mergeNarrativeParagraphs(
  previous: readonly NarrativeParagraphInput[],
  next: readonly NarrativeParagraphInput[],
): NarrativeParagraphInput[] {
  const paragraphs = new Map(
    previous.map((paragraph) => [
      paragraph.targetId ?? paragraph.candidateId,
      paragraph,
    ]),
  );
  for (const paragraph of next) {
    const key = paragraph.targetId ?? paragraph.candidateId;
    const existing = paragraphs.get(key);
    const content = paragraph.appendContent
      ? `${existing?.content ?? ""}${paragraph.content}`
      : paragraph.content;
    const { appendContent: _appendContent, ...value } = paragraph;
    paragraphs.set(
      key,
      existing ? { ...existing, ...value, content } : { ...value, content },
    );
  }
  return [...paragraphs.values()];
}

function mergeNarrativeSections(
  previous: readonly NarrativeSectionInput[],
  next: readonly NarrativeSectionInput[],
): NarrativeSectionInput[] {
  const sections = new Map(
    previous.map((section) => [
      section.targetId ?? section.candidateId,
      section,
    ]),
  );
  for (const section of next) {
    const key = section.targetId ?? section.candidateId;
    const existing = sections.get(key);
    const value = existing
      ? {
          ...existing,
          ...section,
          paragraphs: mergeNarrativeParagraphs(
            existing.paragraphs,
            section.paragraphs,
          ),
        }
      : section;
    sections.set(key, value);
  }
  return [...sections.values()];
}

async function upsertNarrativeDraftLinesHandler(args: {
  draftId: string;
  lines: NarrativeLineInput[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(
      args.lines,
      "剧情线路候选",
      MAX_NARRATIVE_CANDIDATES,
    );
    const { workspace } = requireDraftMode("narrative");
    const draft = await updateNovelWorkbenchDraft<NarrativeDraftPayload>(
      workspace,
      "narrative",
      args.draftId,
      (payload) => {
        const lines = new Map(
          payload.lines.map((line) => [line.candidateId, line]),
        );
        args.lines.forEach((line) => {
          const previous = lines.get(line.candidateId);
          const { appendContent, ...value } = line;
          lines.set(
            line.candidateId,
            previous
              ? {
                  ...previous,
                  ...value,
                  content: appendContent
                    ? `${previous.content ?? ""}${line.content ?? ""}`
                    : (line.content ?? previous.content),
                  keyNodes: mergeNarrativeKeyNodes(
                    previous.keyNodes,
                    line.keyNodes,
                  ),
                }
              : value,
          );
        });
        return { ...payload, lines: [...lines.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertNarrativeDraftArcsHandler(args: {
  draftId: string;
  arcs: NarrativeStoryArcInput[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.arcs, "故事弧候选", MAX_NARRATIVE_CANDIDATES);
    const { workspace } = requireDraftMode("narrative");
    const draft = await updateNovelWorkbenchDraft<NarrativeDraftPayload>(
      workspace,
      "narrative",
      args.draftId,
      (payload) => {
        const arcs = new Map(payload.arcs.map((arc) => [arc.candidateId, arc]));
        args.arcs.forEach((arc) => {
          const previous = arcs.get(arc.candidateId);
          const { appendContent, ...value } = arc;
          arcs.set(
            arc.candidateId,
            previous
              ? {
                  ...previous,
                  ...value,
                  content: appendContent
                    ? `${previous.content ?? ""}${arc.content ?? ""}`
                    : (arc.content ?? previous.content),
                  keyNodes: mergeNarrativeKeyNodes(
                    previous.keyNodes,
                    arc.keyNodes,
                  ),
                }
              : value,
          );
        });
        return { ...payload, arcs: [...arcs.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertNarrativeDraftDirectoriesHandler(args: {
  draftId: string;
  directories: NarrativeDirectoryInput[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(
      args.directories,
      "剧情目录候选",
      MAX_NARRATIVE_CANDIDATES,
    );
    const { workspace } = requireDraftMode("narrative");
    const draft = await updateNovelWorkbenchDraft<NarrativeDraftPayload>(
      workspace,
      "narrative",
      args.draftId,
      (payload) => {
        const directories = new Map(
          (payload.directories ?? []).map((directory) => [
            directory.candidateId,
            directory,
          ]),
        );
        args.directories.forEach((directory) =>
          directories.set(directory.candidateId, directory),
        );
        return { ...payload, directories: [...directories.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertNarrativeDraftChaptersHandler(args: {
  draftId: string;
  chapters: NarrativeChapterInput[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(
      args.chapters,
      "剧情章节候选",
      MAX_NARRATIVE_CANDIDATES,
    );
    const { workspace } = requireDraftMode("narrative");
    const draft = await updateNovelWorkbenchDraft<NarrativeDraftPayload>(
      workspace,
      "narrative",
      args.draftId,
      (payload) => {
        const chapters = new Map(
          (payload.chapters ?? []).map((chapter) => [
            chapter.candidateId,
            chapter,
          ]),
        );
        args.chapters.forEach((chapter) => {
          const previous = chapters.get(chapter.candidateId);
          chapters.set(
            chapter.candidateId,
            previous
              ? {
                  ...previous,
                  ...chapter,
                  sections: mergeNarrativeSections(
                    previous.sections,
                    chapter.sections,
                  ),
                }
              : chapter,
          );
        });
        return { ...payload, chapters: [...chapters.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateNarrativeDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("narrative");
    const draft = await loadNovelWorkbenchDraft<NarrativeDraftPayload>(
      workspace,
      "narrative",
      args.draftId,
    );
    const source = await readNarrativeSource();
    if (narrativeSourceHash(source.content) !== draft.payload.baseSourceHash)
      throw new Error("剧情工程事实源已变化，请重新读取上下文并创建新草稿");
    const errors = validateNarrativeDraftPayload(draft.payload, source.library);
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(draft.payload),
    );
    return result({
      valid: true,
      ...summarizeNovelWorkbenchDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitNarrativeProposalHandler(args: {
  proposalId: string;
  title: string;
  description?: string;
  baseSourceHash: string;
  lines: Record<string, unknown>[];
  arcs: Record<string, unknown>[];
  directories: Record<string, unknown>[];
  chapters: Record<string, unknown>[];
  baseLines: Record<string, unknown>[];
  baseArcs: Record<string, unknown>[];
  baseDirectories: Record<string, unknown>[];
  baseChapters: Record<string, unknown>[];
  updatedLineIds: readonly string[];
  updatedArcIds: readonly string[];
  updatedDirectoryIds: readonly string[];
  updatedChapterIds: readonly string[];
}): Promise<{
  proposalId: string;
  lineCount: number;
  arcCount: number;
  directoryCount: number;
  chapterCount: number;
}> {
  const { workspace, context } = requireDraftMode("narrative");
  const proposalDirectory = workspaceFile(
    workspace,
    `${NARRATIVE_PROPOSAL_ROOT}/${args.proposalId}`,
  );
  if (await readOptional(join(proposalDirectory, "proposal.json")))
    return {
      proposalId: args.proposalId,
      lineCount: args.lines.length,
      arcCount: args.arcs.length,
      directoryCount: args.directories.length,
      chapterCount: args.chapters.length,
    };
  await fs.mkdir(proposalDirectory, { recursive: true });
  const baseLinesById = new Map(
    args.baseLines.map((value) => [String(value.id), value]),
  );
  const baseArcsById = new Map(
    args.baseArcs.map((value) => [String(value.id), value]),
  );
  const baseDirectoriesById = new Map(
    args.baseDirectories.map((value) => [String(value.id), value]),
  );
  const baseChaptersById = new Map(
    args.baseChapters.map((value) => [String(value.id), value]),
  );
  const manifest = {
    schemaVersion: NARRATIVE_PROPOSAL_SCHEMA_VERSION,
    proposalId: args.proposalId,
    title: args.title.trim(),
    description: args.description?.trim() ?? "",
    createdAt: new Date().toISOString(),
    source: {
      kind: "agent",
      promptId: context.promptId,
      promptVersion: context.promptVersion,
    },
    baseSourceHash: args.baseSourceHash,
    lines: args.lines.map((value) => ({
      candidateId: String(value.id),
      summary: `${args.updatedLineIds.includes(String(value.id)) ? "更新" : "新增"}线路：${String(value.title)}`,
      status: "pending",
      value,
      baseValue: baseLinesById.get(String(value.id)) ?? null,
    })),
    arcs: args.arcs.map((value) => ({
      candidateId: String(value.id),
      summary: `${args.updatedArcIds.includes(String(value.id)) ? "更新" : "新增"}故事弧：${String(value.title)}`,
      status: "pending",
      value,
      baseValue: baseArcsById.get(String(value.id)) ?? null,
    })),
    directories: args.directories.map((value) => ({
      candidateId: String(value.id),
      summary: `${args.updatedDirectoryIds.includes(String(value.id)) ? "更新" : "新增"}目录：${String(value.title)}`,
      status: "pending",
      value,
      baseValue: baseDirectoriesById.get(String(value.id)) ?? null,
    })),
    chapters: args.chapters.map((value) => ({
      candidateId: String(value.id),
      summary: `${args.updatedChapterIds.includes(String(value.id)) ? "更新" : "新增"}章节：${String(value.title)}`,
      status: "pending",
      value,
      baseValue: baseChaptersById.get(String(value.id)) ?? null,
    })),
  };
  await fs.writeFile(
    join(proposalDirectory, "proposal.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return {
    proposalId: args.proposalId,
    lineCount: args.lines.length,
    arcCount: args.arcs.length,
    directoryCount: args.directories.length,
    chapterCount: args.chapters.length,
  };
}

async function submitNarrativeDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("narrative");
    const draft = await loadNovelWorkbenchDraft<NarrativeDraftPayload>(
      workspace,
      "narrative",
      args.draftId,
    );
    const proposalId = narrativeProposalId(draft.draftId);
    if (draft.submittedProposalId)
      return result(await getNarrativeProposalStatusHandlerValue(proposalId));
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !==
        hashNovelWorkbenchDraftPayload(draft.payload)
    )
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    const source = await readNarrativeSource();
    if (narrativeSourceHash(source.content) !== draft.payload.baseSourceHash)
      throw new Error("剧情工程事实源已变化，请重新读取上下文");
    const errors = validateNarrativeDraftPayload(draft.payload, source.library);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const materialized = materializeNarrativeDraft(
      draft.payload,
      source.library,
    );
    const persisted = await submitNarrativeProposalHandler({
      proposalId,
      title: draft.payload.title,
      description: draft.payload.description,
      baseSourceHash: draft.payload.baseSourceHash,
      lines: materialized.lines,
      arcs: materialized.arcs,
      directories: materialized.directories,
      chapters: materialized.chapters,
      baseLines: narrativeRecords(source.library, "lines"),
      baseArcs: narrativeRecords(source.library, "arcs"),
      baseDirectories: narrativeRecords(source.library, "directories"),
      baseChapters: narrativeRecords(source.library, "chapters"),
      updatedLineIds: materialized.updatedLineIds,
      updatedArcIds: materialized.updatedArcIds,
      updatedDirectoryIds: materialized.updatedDirectoryIds,
      updatedChapterIds: materialized.updatedChapterIds,
    });
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    const status = await getNarrativeProposalStatusHandlerValue(proposalId);
    return result({
      submitted: true,
      ...persisted,
      ...status,
      draftId: draft.draftId,
      reviewAction:
        "请作者在剧情工程点击“审阅提案”，逐项确认线路、故事弧、目录或章节候选。",
    });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getNarrativeProposalStatusHandlerValue(
  proposalId: string,
): Promise<Record<string, unknown>> {
  const { workspace } = requireDraftMode("narrative");
  const content = await readOptional(
    workspaceFile(
      workspace,
      `${NARRATIVE_PROPOSAL_ROOT}/${proposalId}/proposal.json`,
    ),
  );
  if (!content) return { exists: false, proposalId };
  const manifest = narrativeRecord(JSON.parse(content), "剧情提案");
  const candidates = [
    ...(arrayField(manifest, "lines") ?? []),
    ...(arrayField(manifest, "arcs") ?? []),
    ...(arrayField(manifest, "directories") ?? []),
    ...(arrayField(manifest, "chapters") ?? []),
  ];
  const statuses = candidates.map((candidate) =>
    String(narrativeRecord(candidate, "剧情提案候选").status),
  );
  return {
    exists: true,
    proposalId,
    title: manifest.title,
    pending: statuses.filter((status) => status === "pending").length,
    applied: statuses.filter((status) => status === "applied").length,
    rejected: statuses.filter((status) => status === "rejected").length,
  };
}

async function getNarrativeProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    return result(
      await getNarrativeProposalStatusHandlerValue(args.proposalId),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

async function getContextHandler(args: {
  paths?: string[];
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const paths = new Set([
      `${LIBRARY_ROOT}/meta.json`,
      `${LIBRARY_ROOT}/spatial-tree.json`,
      `${LIBRARY_ROOT}/settings.json`,
      LOCATION_LIBRARY_PATH,
      FACTION_LIBRARY_PATH,
    ]);
    for (const requested of args.paths ?? []) {
      try {
        paths.add(normalizeTargetPath(requested));
      } catch (error) {
        if (
          /^world\/cultivation(?:-ecology\.(?:json|md)|\/)/i.test(requested)
        ) {
          throw new Error(
            "修行体系不是世界架构目标；请改用 novel_cultivation_get_context 读取 world/cultivation/index.json 及其模块",
          );
        }
        throw error;
      }
    }
    const settingsIndex = await readOptional(
      workspaceFile(workspace, `${LIBRARY_ROOT}/settings.json`),
    );
    if (settingsIndex) {
      try {
        const parsed = JSON.parse(settingsIndex) as { settings?: unknown[] };
        for (const setting of recordList(parsed.settings)) {
          for (const key of ["pagePath", "entriesPath"] as const) {
            const target = setting[key];
            if (
              typeof target === "string" &&
              SETTING_FILE_PATTERNS[key].test(target)
            )
              paths.add(target);
          }
        }
      } catch {
        // 世界架构验证工具会报告坏索引；读取上下文仍保留已存在的可读文件。
      }
    }
    const files: Record<string, string | null> = {};
    let locationSourceHash: string | null = null;
    for (const path of paths) {
      if (path === LOCATION_LIBRARY_PATH) {
        const source = await loadLocationSource(workspace);
        files[path] = source?.aggregateContent ?? null;
        locationSourceHash = source
          ? hashNovelWorkbenchDraftPayload(source.snapshot)
          : null;
      } else if (path === FACTION_LIBRARY_PATH) {
        const source = await loadFactionSource(workspace).catch(() => null);
        files[path] = source
          ? `${JSON.stringify(source.library, null, 2)}\n`
          : null;
      } else {
        files[path] = await readOptional(workspaceFile(workspace, path));
      }
    }
    return result({
      mode: context.mode,
      files,
      locationSourceHash,
      sourceHash: hashNovelWorkbenchDraftPayload(files),
      source: "saved-world-architecture",
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getInspirationContextHandler(args: {
  focusId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const loaded = await loadInspirationFiles((path) =>
      fs.readFile(workspaceFile(workspace, path), "utf8"),
    );
    const focusId = args.focusId?.trim();
    const focus = focusId
      ? (loaded.library.items.find((item) => item.id === focusId) ?? null)
      : null;
    return result({
      mode: context.mode,
      sourcePath: focus
        ? inspirationRecordPath(focus.id)
        : INSPIRATION_INDEX_PATH,
      source: "saved-facts",
      sourceHash: hashNovelWorkbenchDraftPayload(
        serializeInspirationFileSnapshot(loaded.files),
      ),
      focusId: focusId ?? null,
      data: focus
        ? { item: focus }
        : {
            schemaVersion: loaded.library.schemaVersion,
            updatedAt: loaded.library.updatedAt,
            items: loaded.library.items.map((item) => {
              return {
                id: item.id,
                title: item.title,
                state: item.state,
                tags: item.tags,
                updatedAt: item.updatedAt,
              };
            }),
          },
      note: "工具返回的是已保存灵感事实；不存在的 focusId 不得臆测内容。",
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateHandler(args: {
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.changes, "世界架构变更");
    const { context } = requireWorkspace();
    if (!["world", "template", "assist"].includes(context.mode)) {
      throw new Error("当前受控会话不是世界架构设计会话");
    }
    const errors = await validateChanges(args.changes);
    return result({ valid: errors.length === 0, errors }, errors.length > 0);
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    assertIncrementalBatch(args.changes, "世界架构变更");
    const { workspace, context } = requireWorkspace();
    if (!["world", "template", "assist"].includes(context.mode)) {
      throw new Error("当前受控会话不是世界架构设计会话");
    }
    const errors = await validateChanges(args.changes);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const proposalId =
      args.proposalId?.trim() || `proposal-${randomUUID().slice(0, 8)}`;
    if (!ID_PATTERN.test(proposalId))
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    const proposalsDirectory = workspaceFile(workspace, PROPOSAL_ROOT);
    proposalDirectory = workspaceFile(
      workspace,
      `${PROPOSAL_ROOT}/${proposalId}`,
    );
    if (await readOptional(join(proposalDirectory, "proposal.json"))) {
      return result({
        submitted: true,
        proposalId,
        recovered: true,
        reviewAction: "请作者在小说工作台点击“审阅提案”进行逐项审批。",
      });
    }
    await fs.mkdir(proposalsDirectory, { recursive: true });
    await fs.mkdir(proposalDirectory);
    createdProposalDirectory = true;

    const manifestChanges = [];
    for (const change of args.changes) {
      const targetPath = normalizeTargetPath(change.targetPath);
      const snapshotRelative = proposalSnapshotRelativePath(targetPath);
      const afterPath = join(
        proposalDirectory,
        "after",
        ...snapshotRelative.split("/"),
      );
      await fs.mkdir(dirname(afterPath), { recursive: true });
      await fs.writeFile(afterPath, change.content, {
        encoding: "utf8",
        flag: "wx",
      });
      if (change.operation === "modify") {
        const beforeContent = await readWorldTarget(workspace, targetPath);
        if (beforeContent === null) {
          throw new Error(`modify 目标不存在：${targetPath}`);
        }
        const beforePath = join(
          proposalDirectory,
          "before",
          ...snapshotRelative.split("/"),
        );
        await fs.mkdir(dirname(beforePath), { recursive: true });
        await fs.writeFile(beforePath, beforeContent, {
          encoding: "utf8",
          flag: "wx",
        });
      }
      manifestChanges.push({
        id: change.id,
        targetPath,
        operation: change.operation,
        summary: change.summary.trim(),
        status: "pending",
      });
    }
    const manifest = {
      schemaVersion: 1,
      proposalId,
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent",
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      changes: manifestChanges,
    };
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return result({
      submitted: true,
      proposalId,
      changeCount: manifestChanges.length,
      reviewAction: "请作者在小说工作台点击“审阅提案”进行逐项审批。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

type WorldDraftPayload = {
  title: string;
  description: string;
  changes: ProposedChange[];
};

type CharacterDraftPayload = {
  title: string;
  description: string;
  operations: CharacterProposalOperation[];
};

type ItemDraftPayload = {
  title: string;
  description: string;
  categoryId: string;
  items: ItemBatchCandidate[];
};

function createCharacterDraftValue(
  operation: CharacterProposalOperation,
  previous?: CharacterProposalOperation,
): Record<string, unknown> {
  const supplied = operation.value;
  if (previous?.kind === operation.kind) {
    return { ...previous.value, ...supplied };
  }
  if (operation.action === "update") return supplied;
  const id = typeof supplied.id === "string" ? supplied.id : "";
  if (operation.kind === "race" || operation.kind === "group") {
    return { id, name: "未命名定义", description: "", ...supplied };
  }
  if (operation.kind === "soul") {
    return {
      id,
      builtIn: false,
      name: "未命名角色灵魂",
      category: "",
      summary: "",
      expressionDna: "",
      mentalModel: "",
      decisionHeuristics: "",
      valueAntiPatterns: "",
      boundaries: "",
      expressionConflictKeywords: [],
      decisionConflictKeywords: [],
      valueConflictKeywords: [],
      amplificationKeywords: [],
      ...supplied,
    };
  }
  return {
    id,
    name: "未命名角色",
    alias: "",
    roleWeight: "secondary",
    archetype: "待定",
    alignment: "绝对中立",
    status: "草稿",
    summary: "",
    identities: [],
    age: "",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    gender: "",
    raceId: "",
    soulId: "",
    groupIds: [],
    hometown: "",
    appearance: "",
    personality: "",
    values: "",
    strengths: "",
    weaknesses: "",
    fears: "",
    motivation: "",
    goals: "",
    innerConflict: "",
    background: "",
    abilities: "",
    speechStyle: "",
    habits: "",
    signatureItem: "",
    storyRole: "",
    arc: "",
    firstAppearance: "未安排",
    completeness: 8,
    relations: [],
    appearances: [],
    arcStages: [],
    inventory: [],
    ...supplied,
  };
}

function requireDraftMode(
  expected:
    | "world"
    | "characters"
    | "items"
    | "factions"
    | "narrative"
    | "manuscript"
    | "cultivation"
    | "timeline"
    | "maps",
): ReturnType<typeof requireWorkspace> {
  const allowed =
    expected === "world"
      ? (["world", "template", "assist"] as const)
      : ([expected] as const);
  return requireWorkbenchMode(allowed);
}

function draftSource(context: ReturnType<typeof requireWorkspace>["context"]) {
  return {
    promptId: context.promptId,
    promptVersion: context.promptVersion,
    sessionId: context.sessionId ?? "unknown-session",
  };
}

function decodeToolResult(value: CallToolResult): Record<string, unknown> {
  const text = value.content[0]?.text ?? "{}";
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function getProposalStatus(
  proposalRoot: string,
  proposalId: string,
  collection: "changes" | "operations" | "items",
): Promise<Record<string, unknown>> {
  const { workspace } = requireWorkspace();
  if (!ID_PATTERN.test(proposalId)) throw new Error("proposalId 非法");
  const content = await readOptional(
    workspaceFile(workspace, `${proposalRoot}/${proposalId}/proposal.json`),
  );
  if (!content) return { exists: false, proposalId };
  const manifest = objectValue(JSON.parse(content), "提案");
  const candidates = arrayField(manifest, collection) ?? [];
  const statuses = candidates.map(
    (candidate) => objectValue(candidate, "提案候选").status,
  );
  return {
    exists: true,
    proposalId,
    title: manifest.title,
    pending: statuses.filter((status) => status === "pending").length,
    applied: statuses.filter((status) => status === "applied").length,
    rejected: statuses.filter((status) => status === "rejected").length,
  };
}

async function createWorldDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("world");
    const draft = await createNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "world",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        changes: [],
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getWorldDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("world");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<WorldDraftPayload>(
          workspace,
          "world",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function applyWorldDraftPatchOperations(
  workspace: string,
  payload: WorldDraftPayload,
  operations: readonly WorldDraftPatchOperation[],
): Promise<{ payload: WorldDraftPayload; changed: readonly string[] }> {
  assertIncrementalBatch(operations, "世界架构增量修订");
  const changes = new Map(
    payload.changes.map((change) => [change.targetPath, change]),
  );
  const changed: string[] = [];
  for (const operation of operations) {
    const targetPath = normalizeTargetPath(operation.targetPath);
    const previous = changes.get(targetPath);
    const sourceContent = previous
      ? previous.content
      : await readWorldTarget(workspace, targetPath);
    const sourceOperation =
      previous?.operation ?? (sourceContent === null ? "create" : "modify");
    let nextContent: string;
    if (operation.action === "text_append") {
      if (targetPath.endsWith(".json")) {
        throw new Error(`文本追加不能用于 JSON 文件：${targetPath}`);
      }
      nextContent = `${sourceContent ?? ""}${operation.content}`;
    } else {
      if (!targetPath.endsWith(".json")) {
        throw new Error(`结构化增量修订只能用于 JSON 文件：${targetPath}`);
      }
      let parsed: unknown;
      if (sourceContent === null) {
        if (operation.action !== "append" || operation.parentId) {
          throw new Error(`目标 JSON 文件不存在，无法修订：${targetPath}`);
        }
        parsed = { ...(operation.initial ?? {}) };
      } else {
        try {
          parsed = JSON.parse(sourceContent);
        } catch (error) {
          throw new Error(`${targetPath} 不是有效 JSON：${message(error)}`);
        }
      }
      if (!isRecord(parsed)) {
        throw new Error(`${targetPath} 的根节点必须是对象`);
      }
      if (operation.action === "merge") {
        const target = findCultivationObjectById(parsed, operation.targetId);
        if (!target) {
          throw new Error(
            `${targetPath} 找不到增量修订目标：${operation.targetId}`,
          );
        }
        assertCultivationPatchFields(operation.fields);
        Object.assign(
          target.value,
          mergeRecord(target.value, operation.fields),
        );
      } else if (operation.action === "append") {
        if (
          !operation.parentId &&
          !Array.isArray(parsed[operation.collection])
        ) {
          parsed[operation.collection] = [];
        }
        appendCultivationValue(
          parsed,
          operation.collection,
          operation.parentId,
          operation.value,
        );
      } else {
        const target = findCultivationObjectById(parsed, operation.targetId);
        if (!target || !target.parent) {
          throw new Error(
            `${targetPath} 找不到可删除的目标：${operation.targetId}`,
          );
        }
        target.parent.splice(target.index, 1);
      }
      nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    if (Buffer.byteLength(nextContent, "utf8") > MAX_CHANGE_BYTES) {
      throw new Error(
        `${targetPath} 生成后超过 ${MAX_CHANGE_BYTES} 字节，请拆分文件或缩小本次内容`,
      );
    }
    changes.set(targetPath, {
      id:
        previous?.id ??
        `world-change-${hashNovelWorkbenchDraftPayload(targetPath).slice(0, 16)}`,
      targetPath,
      operation: sourceOperation,
      summary:
        operation.summary?.trim() || previous?.summary || "世界架构增量修订",
      content: nextContent,
    });
    changed.push(`${operation.action}:${targetPath}`);
  }
  return { payload: { ...payload, changes: [...changes.values()] }, changed };
}

async function patchWorldDraftChangesHandler(args: {
  draftId: string;
  operations: WorldDraftPatchOperation[];
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("world");
    let changed: readonly string[] = [];
    const draft = await updateNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "world",
      args.draftId,
      async (payload) => {
        const result = await applyWorldDraftPatchOperations(
          workspace,
          payload,
          args.operations,
        );
        changed = result.changed;
        return result.payload;
      },
    );
    return result({ ...summarizeNovelWorkbenchDraft(draft), changed });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertWorldDraftChangesHandler(args: {
  draftId: string;
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.changes, "世界架构变更");
    const { workspace } = requireDraftMode("world");
    const draft = await updateNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "world",
      args.draftId,
      (payload) => {
        const changes = new Map(
          payload.changes.map((change) => [change.targetPath, change]),
        );
        for (const change of args.changes)
          changes.set(change.targetPath, change);
        return { ...payload, changes: [...changes.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateWorldDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("world");
    const draft = await loadNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "world",
      args.draftId,
    );
    const errors = await validateChanges(draft.payload.changes);
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(draft.payload),
    );
    return result({
      valid: true,
      ...summarizeNovelWorkbenchDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitWorldDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("world");
    const draft = await loadNovelWorkbenchDraft<WorldDraftPayload>(
      workspace,
      "world",
      args.draftId,
    );
    const hash = hashNovelWorkbenchDraftPayload(draft.payload);
    if (draft.submittedProposalId) {
      return result(
        await getProposalStatus(
          PROPOSAL_ROOT,
          draft.submittedProposalId,
          "changes",
        ),
      );
    }
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !== hash
    ) {
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    }
    const proposalId = `world-${draft.draftId}`;
    const submitted = await submitHandler({ proposalId, ...draft.payload });
    if (submitted.isError) return submitted;
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    return result({ ...decodeToolResult(submitted), draftId: draft.draftId });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getWorldProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    requireDraftMode("world");
    return result(
      await getProposalStatus(PROPOSAL_ROOT, args.proposalId, "changes"),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

async function createCharacterDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("characters");
    const draft = await createNovelWorkbenchDraft<CharacterDraftPayload>(
      workspace,
      "characters",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        operations: [],
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getCharacterDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("characters");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<CharacterDraftPayload>(
          workspace,
          "characters",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertCharacterDraftOperationsHandler(args: {
  draftId: string;
  operations: CharacterProposalOperation[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.operations, "人物库候选");
    const { workspace } = requireDraftMode("characters");
    const draft = await updateNovelWorkbenchDraft<CharacterDraftPayload>(
      workspace,
      "characters",
      args.draftId,
      (payload) => {
        const operations = new Map(
          payload.operations.map((operation) => [
            operation.candidateId,
            operation,
          ]),
        );
        for (const operation of args.operations) {
          const previous = operations.get(operation.candidateId);
          operations.set(operation.candidateId, {
            ...operation,
            value: createCharacterDraftValue(operation, previous),
          });
        }
        return { ...payload, operations: [...operations.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateCharacterDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("characters");
    const draft = await loadNovelWorkbenchDraft<CharacterDraftPayload>(
      workspace,
      "characters",
      args.draftId,
    );
    const errors = await validateCharacterProposal(draft.payload.operations);
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(draft.payload),
    );
    return result({
      valid: true,
      ...summarizeNovelWorkbenchDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitCharacterDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("characters");
    const draft = await loadNovelWorkbenchDraft<CharacterDraftPayload>(
      workspace,
      "characters",
      args.draftId,
    );
    const hash = hashNovelWorkbenchDraftPayload(draft.payload);
    if (draft.submittedProposalId)
      return result(
        await getProposalStatus(
          CHARACTER_PROPOSAL_ROOT,
          draft.submittedProposalId,
          "operations",
        ),
      );
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !== hash
    )
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    const proposalId = `characters-${draft.draftId}`;
    const submitted = await submitCharacterProposalHandler({
      proposalId,
      ...draft.payload,
    });
    if (submitted.isError) return submitted;
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    return result({ ...decodeToolResult(submitted), draftId: draft.draftId });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getCharacterProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    requireDraftMode("characters");
    return result(
      await getProposalStatus(
        CHARACTER_PROPOSAL_ROOT,
        args.proposalId,
        "operations",
      ),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

async function createItemDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
  categoryId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("items");
    const draft = await createNovelWorkbenchDraft<ItemDraftPayload>(
      workspace,
      "items",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        categoryId: args.categoryId,
        items: [],
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getItemDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("items");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<ItemDraftPayload>(
          workspace,
          "items",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertItemDraftItemsHandler(args: {
  draftId: string;
  items: ItemBatchCandidate[];
}): Promise<CallToolResult> {
  try {
    assertIncrementalBatch(args.items, "物品候选", MAX_BATCH_ITEMS);
    const { workspace } = requireDraftMode("items");
    const draft = await updateNovelWorkbenchDraft<ItemDraftPayload>(
      workspace,
      "items",
      args.draftId,
      (payload) => {
        const items = new Map(
          payload.items.map((item) => [
            item.name.trim().toLocaleLowerCase("zh-CN"),
            item,
          ]),
        );
        for (const item of args.items) {
          const key = item.name.trim().toLocaleLowerCase("zh-CN");
          const previous = items.get(key);
          const { appendDescription, ...nextItem } = item;
          const merged: ItemBatchCandidate = {
            ...previous,
            ...nextItem,
            aliases: item.aliases ?? previous?.aliases,
            tags: item.tags ?? previous?.tags,
            summary: item.summary ?? previous?.summary,
            values:
              item.values || previous?.values
                ? { ...(previous?.values ?? {}), ...(item.values ?? {}) }
                : undefined,
            description:
              appendDescription && previous?.description
                ? `${previous.description}${item.description ?? ""}`
                : (item.description ?? previous?.description),
          };
          items.set(key, merged);
        }
        return { ...payload, items: [...items.values()] };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateItemDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("items");
    const draft = await loadNovelWorkbenchDraft<ItemDraftPayload>(
      workspace,
      "items",
      args.draftId,
    );
    const errors = await validateItemBatch(
      draft.payload.categoryId,
      draft.payload.items,
    );
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const saved = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(draft.payload),
    );
    return result({
      valid: true,
      ...summarizeNovelWorkbenchDraft(saved),
      validationToken: saved.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitItemDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("items");
    const draft = await loadNovelWorkbenchDraft<ItemDraftPayload>(
      workspace,
      "items",
      args.draftId,
    );
    const hash = hashNovelWorkbenchDraftPayload(draft.payload);
    if (draft.submittedProposalId)
      return result(
        await getProposalStatus(
          ITEM_PROPOSAL_ROOT,
          draft.submittedProposalId,
          "items",
        ),
      );
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !== hash
    )
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    const proposalId = `items-${draft.draftId}`;
    const submitted = await submitItemBatchHandler({
      proposalId,
      ...draft.payload,
    });
    if (submitted.isError) return submitted;
    await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
    return result({ ...decodeToolResult(submitted), draftId: draft.draftId });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getItemProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    requireDraftMode("items");
    return result(
      await getProposalStatus(ITEM_PROPOSAL_ROOT, args.proposalId, "items"),
    );
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

function manuscriptSourceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readManuscriptIndex(workspace: string): Promise<{
  content: string;
  index: Record<string, unknown>;
  chapters: Record<string, unknown>[];
}> {
  const content = await fs.readFile(
    workspaceFile(workspace, MANUSCRIPT_INDEX_PATH),
    "utf8",
  );
  const index = objectValue(JSON.parse(content), "正文索引");
  const chapters = arrayField(index, "chapters");
  if (!chapters) throw new Error("正文索引缺少 chapters 数组");
  return {
    content,
    index,
    chapters: chapters.map((chapter) => objectValue(chapter, "正文章节")),
  };
}

function manuscriptChapter(
  chapters: readonly Record<string, unknown>[],
  chapterId: string,
): Record<string, unknown> {
  const chapter = chapters.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error(`正文章节不存在：${chapterId}`);
  if (
    typeof chapter.title !== "string" ||
    typeof chapter.path !== "string" ||
    !/^manuscript\/chapters\/\d{6}\.md$/u.test(chapter.path)
  ) {
    throw new Error(`正文章节记录无效：${chapterId}`);
  }
  return chapter;
}

async function getManuscriptContextHandler(args: {
  chapterId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const loaded = await readManuscriptIndex(workspace);
    const chapterId = args.chapterId;
    const selected = args.chapterId
      ? manuscriptChapter(loaded.chapters, args.chapterId)
      : null;
    const selectedContent = selected
      ? await fs.readFile(
          workspaceFile(workspace, String(selected.path)),
          "utf8",
        )
      : null;
    let narrativePlan: Record<string, unknown> | null = null;
    if (selected && typeof selected.narrativeChapterId === "string") {
      const narrativeIndex = await readOptional(
        workspaceFile(workspace, NARRATIVE_ENGINEERING_PATH),
      );
      if (narrativeIndex) {
        const narrative = (await loadNarrativeSourceFromWorkspace(workspace))
          .library;
        narrativePlan =
          (arrayField(narrative, "chapters") ?? [])
            .map((value) => objectValue(value, "剧情章节"))
            .find((value) => value.id === selected.narrativeChapterId) ?? null;
      }
    }
    return result({
      sourcePath: MANUSCRIPT_INDEX_PATH,
      sourceHash:
        selectedContent === null ? null : manuscriptSourceHash(selectedContent),
      chapterIndexHash: manuscriptSourceHash(loaded.content),
      structureMode: loaded.index.structureMode,
      directories: arrayField(loaded.index, "directories") ?? [],
      chapters: loaded.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        path: chapter.path,
        displayNumber: chapter.displayNumber,
        directoryId: chapter.directoryId,
        narrativeChapterId: chapter.narrativeChapterId,
        status: chapter.status,
      })),
      selectedChapter: selected
        ? { ...selected, content: selectedContent, narrativePlan }
        : null,
      note: chapterId
        ? "sourceHash 绑定当前章节完整正文；创建草稿时必须原样传回。"
        : "传 chapterId 可读取章节全文、sourceHash 和关联剧情计划。",
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getFactionContextHandler(args: {
  factionId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const source = await loadFactionSource(workspace);
    const factions = source.library.factions.map((value) =>
      objectValue(value, "势力组织"),
    );
    return result({
      sourcePath: FACTION_LIBRARY_PATH,
      sourceHash: manuscriptSourceHash(source.snapshot),
      factions: args.factionId
        ? factions.filter((faction) => faction.id === args.factionId)
        : factions,
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function getContinuityContextHandler(args: {
  chapterId?: string;
  batchId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const [trackingIndex, continuityIndex, continuityLegacy] =
      await Promise.all([
        readOptional(workspaceFile(workspace, MANUSCRIPT_TRACKING_INDEX_PATH)),
        readOptional(
          workspaceFile(workspace, MANUSCRIPT_CONTINUITY_INDEX_PATH),
        ),
        readOptional(
          workspaceFile(workspace, MANUSCRIPT_CONTINUITY_LEGACY_PATH),
        ),
      ]);
    if (continuityIndex === null && continuityLegacy !== null) {
      throw new Error(
        `${MANUSCRIPT_CONTINUITY_LEGACY_PATH} 是旧单文件正文连续性状态；当前目录协议不兼容且不迁移`,
      );
    }
    const tracking = trackingIndex
      ? await loadManuscriptTrackingFiles((path) =>
          fs.readFile(workspaceFile(workspace, path), "utf8"),
        )
      : null;
    const continuity = continuityIndex
      ? await loadManuscriptContinuityFiles((path) =>
          fs.readFile(workspaceFile(workspace, path), "utf8"),
        )
      : null;
    const requestedBatch = args.batchId
      ? (tracking?.ledger.batches.find((batch) => batch.id === args.batchId) ??
        null)
      : null;
    if (args.batchId && !requestedBatch) {
      throw new Error(`正文状态批次不存在：${args.batchId}`);
    }
    const batches = tracking?.ledger.batches.filter(
      (batch) => !args.chapterId || batch.chapterId === args.chapterId,
    );
    const continuityState = continuity
      ? {
          ...continuity.state,
          facts: continuity.state.facts.filter(
            (fact) => !args.chapterId || fact.chapterId === args.chapterId,
          ),
        }
      : null;
    const trackingPath = requestedBatch
      ? manuscriptTrackingBatchPath(requestedBatch.id)
      : MANUSCRIPT_TRACKING_INDEX_PATH;
    return result({
      trackingPath,
      continuityPath: MANUSCRIPT_CONTINUITY_INDEX_PATH,
      trackingSourceHash: tracking
        ? hashNovelWorkbenchDraftPayload(
            serializeManuscriptTrackingFileSnapshot(tracking.files),
          )
        : null,
      continuitySourceHash: continuity
        ? hashNovelWorkbenchDraftPayload(
            serializeManuscriptContinuityFileSnapshot(continuity.files),
          )
        : null,
      tracking: tracking
        ? requestedBatch
          ? { batch: requestedBatch }
          : {
              schemaVersion: tracking.ledger.schemaVersion,
              updatedAt: tracking.ledger.updatedAt,
              baselinesCount: Object.keys(tracking.ledger.baselines).length,
              batches: batches?.map((batch) => ({
                id: batch.id,
                chapterId: batch.chapterId,
                summary: batch.summary,
                status: batch.status,
                createdAt: batch.createdAt,
                appliedAt: batch.appliedAt,
                revertedAt: batch.revertedAt,
                changeCount: Array.isArray(batch.changes)
                  ? batch.changes.length
                  : 0,
              })),
            }
        : null,
      continuity: continuityState,
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function createManuscriptDraftHandler(args: {
  draftId?: string;
  title: string;
  description?: string;
  runId: string;
  chapterId: string;
  baseSourceHash: string;
  mode: ManuscriptWritingMode;
  rangeStart: number;
  rangeEnd: number;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireDraftMode("manuscript");
    const loaded = await readManuscriptIndex(workspace);
    const chapter = manuscriptChapter(loaded.chapters, args.chapterId);
    const sourceContent = await fs.readFile(
      workspaceFile(workspace, String(chapter.path)),
      "utf8",
    );
    if (manuscriptSourceHash(sourceContent) !== args.baseSourceHash) {
      throw new Error("正文事实源已变化，请重新读取章节上下文");
    }
    if (
      args.rangeStart < 0 ||
      args.rangeEnd < args.rangeStart ||
      args.rangeEnd > sourceContent.length
    ) {
      throw new Error("正文处理范围越界");
    }
    const draft = await createNovelWorkbenchDraft<ManuscriptDraftPayload>(
      workspace,
      "manuscript",
      draftSource(context),
      {
        title: args.title.trim(),
        description: args.description?.trim() ?? "",
        runId: args.runId,
        chapterId: args.chapterId,
        chapterTitle: String(chapter.title),
        chapterPath: String(chapter.path),
        baseSourceHash: args.baseSourceHash,
        sourceContent,
        mode: args.mode,
        rangeStart: args.rangeStart,
        rangeEnd: args.rangeEnd,
        candidate: null,
      },
      args.draftId,
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ created: false, error: message(error) }, true);
  }
}

async function getManuscriptDraftHandler(args: {
  draftId: string;
  includeContent?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("manuscript");
    return result(
      summarizeNovelWorkbenchDraft(
        await loadNovelWorkbenchDraft<ManuscriptDraftPayload>(
          workspace,
          "manuscript",
          args.draftId,
        ),
        args.includeContent === true,
      ),
    );
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function upsertManuscriptCandidateHandler(args: {
  draftId: string;
  candidateId: string;
  content: string;
  append?: boolean;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("manuscript");
    if (Buffer.byteLength(args.content, "utf8") > MAX_INCREMENTAL_BATCH_BYTES) {
      throw new Error(
        `正文单次增量最多 ${MAX_INCREMENTAL_BATCH_BYTES} 字节，请分块调用`,
      );
    }
    const draft = await updateNovelWorkbenchDraft<ManuscriptDraftPayload>(
      workspace,
      "manuscript",
      args.draftId,
      (payload) => {
        if (payload.candidate && payload.candidate.id !== args.candidateId) {
          throw new Error("同一正文草稿不能混用不同的候选 ID");
        }
        if (payload.candidate && !args.append) {
          throw new Error("正文候选已创建，后续内容必须使用 append=true 追加");
        }
        if (!payload.candidate && args.append) {
          throw new Error("正文候选尚未创建，首块不能使用 append=true");
        }
        const previous = payload.candidate?.content ?? "";
        const content = `${previous}${args.content}`;
        if (Buffer.byteLength(content, "utf8") > MAX_MANUSCRIPT_CONTENT_BYTES) {
          throw new Error("正文候选累计超过 4 MiB 限制");
        }
        return {
          ...payload,
          candidate: { id: args.candidateId, content },
        };
      },
    );
    return result(summarizeNovelWorkbenchDraft(draft));
  } catch (error) {
    return result({ updated: false, error: message(error) }, true);
  }
}

async function validateManuscriptDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("manuscript");
    const draft = await loadNovelWorkbenchDraft<ManuscriptDraftPayload>(
      workspace,
      "manuscript",
      args.draftId,
    );
    const errors: string[] = [];
    if (!draft.payload.candidate?.content.trim())
      errors.push("正文候选不能为空");
    if (draft.payload.rangeEnd > draft.payload.sourceContent.length) {
      errors.push("正文处理范围越界");
    }
    const current = await fs.readFile(
      workspaceFile(workspace, draft.payload.chapterPath),
      "utf8",
    );
    if (manuscriptSourceHash(current) !== draft.payload.baseSourceHash) {
      errors.push("正文事实源已变化，请重新生成");
    }
    if (errors.length > 0) return result({ valid: false, errors }, true);
    const contentHash = hashNovelWorkbenchDraftPayload(draft.payload);
    const validated = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      contentHash,
    );
    return result({
      valid: true,
      draftId: validated.draftId,
      revision: validated.revision,
      validationToken: validated.validation?.token,
    });
  } catch (error) {
    return result({ valid: false, error: message(error) }, true);
  }
}

function manuscriptProposalId(draftId: string): string {
  return `proposal-${draftId}`;
}

function assertManuscriptProposalMatchesDraft(
  proposal: ManuscriptProposal,
  draft: NovelWorkbenchDraft<ManuscriptDraftPayload>,
): void {
  const payload = draft.payload;
  if (
    proposal.proposalId !== manuscriptProposalId(draft.draftId) ||
    proposal.draftId !== draft.draftId ||
    proposal.runId !== payload.runId ||
    proposal.source.chapterId !== payload.chapterId ||
    proposal.source.chapterTitle !== payload.chapterTitle ||
    proposal.source.chapterPath !== payload.chapterPath ||
    proposal.source.sourceHash !== payload.baseSourceHash ||
    proposal.source.sourceContent !== payload.sourceContent ||
    proposal.source.rangeStart !== payload.rangeStart ||
    proposal.source.rangeEnd !== payload.rangeEnd ||
    proposal.source.mode !== payload.mode ||
    proposal.candidate.id !== payload.candidate?.id ||
    proposal.candidate.content !== payload.candidate?.content
  ) {
    throw new Error("已存在的正文候选与当前草稿不一致");
  }
}

async function recoverExistingManuscriptProposal(
  workspace: string,
  draft: NovelWorkbenchDraft<ManuscriptDraftPayload>,
  proposalId: string,
): Promise<boolean> {
  const proposalPath = workspaceFile(
    workspace,
    `${MANUSCRIPT_PROPOSAL_ROOT}/${proposalId}/proposal.json`,
  );
  const content = await readOptional(proposalPath);
  if (!content) return false;
  const proposal = manuscriptProposalSchema.parse(JSON.parse(content));
  assertManuscriptProposalMatchesDraft(proposal, draft);
  await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
  return true;
}

async function getManuscriptProposalStatusValue(
  proposalId: string,
): Promise<Record<string, unknown>> {
  const { workspace } = requireDraftMode("manuscript");
  const content = await readOptional(
    workspaceFile(
      workspace,
      `${MANUSCRIPT_PROPOSAL_ROOT}/${proposalId}/proposal.json`,
    ),
  );
  if (!content) return { exists: false, proposalId };
  const proposal = manuscriptProposalSchema.parse(JSON.parse(content));
  return {
    exists: true,
    proposalId,
    runId: proposal.runId,
    chapterId: proposal.source.chapterId,
    status: proposal.candidate.status,
    updatedAt: proposal.updatedAt,
  };
}

async function submitManuscriptDraftHandler(args: {
  draftId: string;
  validationToken: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireDraftMode("manuscript");
    const draft = await loadNovelWorkbenchDraft<ManuscriptDraftPayload>(
      workspace,
      "manuscript",
      args.draftId,
    );
    const proposalId = manuscriptProposalId(draft.draftId);
    if (draft.submittedProposalId) {
      return result(await getManuscriptProposalStatusValue(proposalId));
    }
    if (
      draft.validation?.token !== args.validationToken ||
      draft.validation.contentHash !==
        hashNovelWorkbenchDraftPayload(draft.payload)
    ) {
      throw new Error("校验令牌无效或草稿已经变化，请重新校验");
    }
    if (!draft.payload.candidate) throw new Error("正文草稿尚无候选内容");
    const current = await fs.readFile(
      workspaceFile(workspace, draft.payload.chapterPath),
      "utf8",
    );
    if (manuscriptSourceHash(current) !== draft.payload.baseSourceHash) {
      throw new Error("正文事实源已变化，请重新读取并生成");
    }
    const now = new Date().toISOString();
    const proposal: ManuscriptProposal = {
      schemaVersion: 1,
      proposalId,
      draftId: draft.draftId,
      runId: draft.payload.runId,
      title: draft.payload.title,
      description: draft.payload.description,
      createdAt: now,
      updatedAt: now,
      source: {
        chapterId: draft.payload.chapterId,
        chapterTitle: draft.payload.chapterTitle,
        chapterPath: draft.payload.chapterPath,
        sourceHash: draft.payload.baseSourceHash,
        sourceContent: draft.payload.sourceContent,
        rangeStart: draft.payload.rangeStart,
        rangeEnd: draft.payload.rangeEnd,
        mode: draft.payload.mode,
      },
      candidate: {
        id: draft.payload.candidate.id,
        status: "pending",
        content: draft.payload.candidate.content,
        appliedContent: null,
      },
    };
    const directory = workspaceFile(
      workspace,
      `${MANUSCRIPT_PROPOSAL_ROOT}/${proposalId}`,
    );
    await fs.mkdir(directory, { recursive: true });
    const recovered = await recoverExistingManuscriptProposal(
      workspace,
      draft,
      proposalId,
    );
    if (!recovered) {
      try {
        await fs.writeFile(
          join(directory, "proposal.json"),
          serializeManuscriptProposal(proposal),
          { encoding: "utf8", flag: "wx" },
        );
        await markNovelWorkbenchDraftSubmitted(workspace, draft, proposalId);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await recoverExistingManuscriptProposal(
            workspace,
            draft,
            proposalId,
          ))
        ) {
          throw error;
        }
      }
    }
    return result({
      submitted: true,
      ...(await getManuscriptProposalStatusValue(proposalId)),
      reviewAction: "正文候选已提交到右侧差异审阅区，等待作者确认。",
    });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getManuscriptProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    return result(await getManuscriptProposalStatusValue(args.proposalId));
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
  }
}

type NovelKnowledgeSearchHit = {
  readonly id: string;
  readonly path: string;
  readonly score: number;
  readonly snippet: string;
  readonly citations: readonly {
    readonly path: string;
    readonly line: number;
  }[];
  readonly retrieval: {
    readonly lexicalScore: number;
    readonly semanticScore: number;
    readonly rerankScore: number;
  };
};

async function listNovelKnowledgeDocuments(
  workspace: string,
  directory = "",
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const absolute = workspaceFile(workspace, directory);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const result: { path: string; content: string }[] = [];
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (
      entry.name === ".git" ||
      relative.startsWith("prompts/") ||
      relative.startsWith("knowledge/derived/") ||
      relative.includes("/proposals/")
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      result.push(...(await listNovelKnowledgeDocuments(workspace, relative)));
      continue;
    }
    if (!/\.(?:md|json)$/iu.test(entry.name)) continue;
    const content = await fs.readFile(
      workspaceFile(workspace, relative),
      "utf8",
    );
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) continue;
    result.push({ path: relative.replace(/\\/g, "/"), content });
  }
  return result;
}

async function searchNovelKnowledgeHandler(args: {
  query: string;
  limit?: number;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const query = args.query.trim();
    if (!query) throw new Error("知识检索 query 不能为空");
    const documents = [...(await listNovelKnowledgeDocuments(workspace))].sort(
      (a, b) => a.path.localeCompare(b.path),
    );
    const source = documents
      .map((document) => `${document.path}\u0000${document.content}`)
      .join("\u0001");
    const sourceHash = createHash("sha256")
      .update(source, "utf8")
      .digest("hex");
    const hits: readonly NovelKnowledgeSearchHit[] = retrieveKnowledgeDocuments(
      documents,
      query,
      Math.min(Math.max(args.limit ?? 8, 1), 30),
    );
    return result({
      mode: context.mode,
      retrieverVersion: "hybrid-ngram-rerank-v2",
      query,
      sourceHash,
      results: hits,
      note: "结果来自已保存项目事实源，snippet 仅用于引用定位；Agent 需要时应依据 citations 重新读取原文。",
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

export async function createNovelWorkbenchServer() {
  const { createSdkMcpServer, tool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );
  const { z } = await import("zod/v4");
  const changeSchema = z.object({
    id: z.string().regex(ID_PATTERN),
    targetPath: z.string(),
    operation: z.enum(["create", "modify"]),
    summary: z.string().min(1),
    content: z.string().max(MAX_INCREMENTAL_BATCH_BYTES),
  });
  const worldDraftPatchOperationSchema = z.discriminatedUnion("action", [
    z.object({
      targetPath: z.string(),
      action: z.literal("merge"),
      targetId: z.string().regex(ID_PATTERN),
      fields: z.record(z.string(), z.unknown()),
      summary: z.string().trim().max(200).optional(),
    }),
    z.object({
      targetPath: z.string(),
      action: z.literal("append"),
      collection: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
      parentId: z.string().regex(ID_PATTERN).optional(),
      value: z.unknown(),
      initial: z.record(z.string(), z.unknown()).optional(),
      summary: z.string().trim().max(200).optional(),
    }),
    z.object({
      targetPath: z.string(),
      action: z.literal("remove"),
      targetId: z.string().regex(ID_PATTERN),
      summary: z.string().trim().max(200).optional(),
    }),
    z.object({
      targetPath: z.string(),
      action: z.literal("text_append"),
      content: z.string().max(MAX_INCREMENTAL_BATCH_BYTES),
      summary: z.string().trim().max(200).optional(),
    }),
  ]);
  const narrativeExpectedSourceHashSchema = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .describe("调用 novel_narrative_get_context 后返回的 sourceHash");
  const narrativeKeyNodeInputSchema = z.object({
    nodeId: z.string().regex(ID_PATTERN),
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(160_000),
    locations: z
      .array(
        z.object({
          chapterId: z.string().regex(ID_PATTERN),
          sectionId: z.string().regex(ID_PATTERN).nullable(),
        }),
      )
      .max(100)
      .optional(),
  });
  const narrativeLineInputSchema = z.object({
    candidateId: z.string().regex(ID_PATTERN),
    targetId: z
      .string()
      .regex(ID_PATTERN)
      .optional()
      .describe("更新既有线路时填写其稳定 ID；省略则创建新线路"),
    title: z.string().trim().min(1).max(160),
    kind: z
      .enum(["main", "emotion", "mirror", "information", "theme", "custom"])
      .optional(),
    storyRole: z.enum(["a", "b", "both", "none"]).optional(),
    status: z.enum(["idea", "active", "resolved", "paused"]).optional(),
    premise: z.string().max(20_000).optional(),
    content: z.string().max(160_000).optional(),
    appendContent: z.boolean().optional(),
    protagonistCharacterId: z.string().regex(ID_PATTERN).nullable().optional(),
    keyNodes: z.array(narrativeKeyNodeInputSchema).min(1).max(30),
  });
  const narrativeStoryArcInputSchema = z.object({
    candidateId: z.string().regex(ID_PATTERN),
    targetId: z
      .string()
      .regex(ID_PATTERN)
      .optional()
      .describe("更新既有故事弧时填写其稳定 ID；省略则创建新故事弧"),
    title: z.string().trim().min(1).max(160),
    kind: z
      .enum(["plot", "character", "relationship", "mystery", "theme", "custom"])
      .optional(),
    characterId: z.string().regex(ID_PATTERN).nullable().optional(),
    characterArcStageId: z.string().regex(ID_PATTERN).nullable().optional(),
    characterArcStageTitle: z.string().max(160).optional(),
    lineIds: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
    content: z.string().max(160_000).optional(),
    appendContent: z.boolean().optional(),
    keyNodes: z.array(narrativeKeyNodeInputSchema).min(1).max(30),
  });
  const narrativeDirectoryInputSchema = z.object({
    candidateId: z
      .string()
      .regex(ID_PATTERN)
      .describe("本草稿内的目录候选 ID，也可供其它目录的 parentId 引用"),
    targetId: z
      .string()
      .regex(ID_PATTERN)
      .optional()
      .describe("更新既有目录时填写其稳定 ID；省略则创建新目录"),
    parentId: z
      .string()
      .regex(ID_PATTERN)
      .nullable()
      .describe("父目录候选 ID、已有目录稳定 ID；根卷使用 null"),
    kind: z.enum(["volume", "part", "group"]),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(160_000).optional(),
    status: z.enum(["idea", "planned", "drafting", "complete"]).optional(),
    order: z.number().int().nonnegative().max(100_000),
  });
  const narrativeParagraphInputSchema = z.object({
    candidateId: z.string().regex(ID_PATTERN).describe("本草稿内的段候选 ID"),
    targetId: z
      .string()
      .regex(ID_PATTERN)
      .optional()
      .describe("更新既有段时填写其稳定 ID"),
    order: z.number().int().nonnegative().max(100_000),
    content: z.string().trim().min(1).max(160_000),
    appendContent: z.boolean().optional(),
  });
  const narrativeSectionInputSchema = z.object({
    candidateId: z.string().regex(ID_PATTERN).describe("本草稿内的节候选 ID"),
    targetId: z
      .string()
      .regex(ID_PATTERN)
      .optional()
      .describe("更新既有节时填写其稳定 ID；必须属于目标章节"),
    order: z.number().int().nonnegative().max(100_000),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(160_000).default(""),
    povCharacterId: z.string().regex(ID_PATTERN).nullable().optional(),
    lineIds: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
    arcIds: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
    paragraphs: z.array(narrativeParagraphInputSchema).max(100).default([]),
  });
  const narrativeChapterInputSchema = z.object({
    candidateId: z.string().regex(ID_PATTERN).describe("本草稿内的章节候选 ID"),
    targetId: z
      .string()
      .regex(ID_PATTERN)
      .optional()
      .describe("更新既有章节时填写其稳定 ID；省略则创建新章节"),
    directoryId: z
      .string()
      .regex(ID_PATTERN)
      .nullable()
      .describe("目录候选 ID、已有卷篇组目录稳定 ID，或 null 表示未归类"),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(160_000).default(""),
    status: z.enum(["idea", "planned", "drafting", "complete"]).optional(),
    order: z.number().int().nonnegative().max(100_000),
    lineIds: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
    arcIds: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
    sections: z.array(narrativeSectionInputSchema).min(1).max(50),
  });
  const itemFieldValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]);
  const itemBatchCandidateSchema = z.object({
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    summary: z.string().optional(),
    values: z.record(z.string(), itemFieldValueSchema).optional(),
    description: z.string().optional(),
    appendDescription: z.boolean().optional(),
  });
  const characterProposalOperationSchema = z.object({
    candidateId: z.string().regex(ID_PATTERN),
    kind: z.enum(["character", "race", "group", "soul"]),
    action: z.enum(["create", "update"]),
    targetId: z.string().regex(ID_PATTERN).optional(),
    baseValue: z.record(z.string(), z.unknown()).optional(),
    summary: z.string().min(1),
    value: z.record(z.string(), z.unknown()),
  });
  return createSdkMcpServer({
    name: NOVEL_WORKBENCH_SDK_ADAPTER_ID,
    version: "1.0.0",
    instructions: NOVEL_WORKBENCH_SDK_INSTRUCTIONS,
    tools: [
      tool(
        "novel_world_create_draft",
        "在作者确认目标后创建可恢复的世界架构草稿。草稿不会修改正式设定，后续所有变更都必须写入这份草稿。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
        },
        createWorldDraftHandler,
      ),
      tool(
        "novel_world_get_draft",
        "读取世界架构草稿状态。默认只返回候选计数、ID、大小和哈希；确实需要完整候选时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getWorldDraftHandler,
      ),
      tool(
        "novel_world_upsert_draft_changes",
        "将不超过 64 KB 的小批量世界架构变更写入草稿；同一目标文件只保留最后一次变更。大文件必须使用 novel_world_patch_draft_changes 分多次增量修订，不得一次提交完整大 JSON。",
        {
          draftId: z.string().regex(ID_PATTERN),
          changes: z.array(changeSchema).min(1).max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertWorldDraftChangesHandler,
      ),
      tool(
        "novel_world_patch_draft_changes",
        "按目标 JSON 中的稳定 ID 增量合并、追加或删除对象；也可按小块追加 Markdown。每次最多 32 项、64 KB，适合多次小量写入，不会把完整 settings.json 重新传给模型。",
        {
          draftId: z.string().regex(ID_PATTERN),
          operations: z
            .array(worldDraftPatchOperationSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        patchWorldDraftChangesHandler,
      ),
      tool(
        "novel_world_validate_draft",
        "完整校验世界架构草稿的文件闭合、Schema、空间与地点引用。成功后返回绑定当前 revision 的 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateWorldDraftHandler,
      ),
      tool(
        "novel_world_submit_draft",
        "使用 validationToken 提交世界架构草稿。每份草稿最多成功提交一次，提交后必须再查询状态才能声明成功。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitWorldDraftHandler,
      ),
      tool(
        "novel_world_get_proposal_status",
        "从磁盘确认世界架构提案是否真实存在及其待审、已采纳、已拒绝数量。只有 exists=true 才能向作者宣称提交成功。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getWorldProposalStatusHandler,
      ),
      tool(
        "novel_characters_create_draft",
        "创建可恢复的人物库提案草稿。先创建草稿，再逐批添加角色、种族、分组或角色灵魂候选。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
        },
        createCharacterDraftHandler,
      ),
      tool(
        "novel_characters_get_draft",
        "读取人物库草稿状态。默认返回摘要；确实需要完整候选时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getCharacterDraftHandler,
      ),
      tool(
        "novel_characters_upsert_draft_operations",
        "把一批人物库候选增量写入草稿。按 candidateId 合并，可分批完成，未提供的候选保持不变。",
        {
          draftId: z.string().regex(ID_PATTERN),
          operations: z
            .array(characterProposalOperationSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertCharacterDraftOperationsHandler,
      ),
      tool(
        "novel_characters_validate_draft",
        "校验人物库草稿的角色卡、定义、关系与物品引用；成功后返回 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateCharacterDraftHandler,
      ),
      tool(
        "novel_characters_submit_draft",
        "使用 validationToken 创建待作者审批的人物库提案。不会修改正式人物库。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitCharacterDraftHandler,
      ),
      tool(
        "novel_characters_get_proposal_status",
        "从磁盘确认角色提案是否真实存在及其待审、已采纳、已拒绝数量。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getCharacterProposalStatusHandler,
      ),
      tool(
        "novel_items_create_draft",
        "在确认分类后创建可恢复的物品批量草稿。草稿不写入正式物品库。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          categoryId: z.string().regex(ID_PATTERN),
        },
        createItemDraftHandler,
      ),
      tool(
        "novel_items_get_draft",
        "读取物品批量草稿状态。默认返回摘要；确实需要完整候选时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getItemDraftHandler,
      ),
      tool(
        "novel_items_upsert_draft_items",
        "按物品名称增量新增或替换草稿候选；可分批生成，不需要一次提供整批物品。",
        {
          draftId: z.string().regex(ID_PATTERN),
          items: z.array(itemBatchCandidateSchema).min(1).max(MAX_BATCH_ITEMS),
        },
        upsertItemDraftItemsHandler,
      ),
      tool(
        "novel_items_validate_draft",
        "校验物品草稿的分类、继承字段、名称重复、类型和必填项；成功后返回 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateItemDraftHandler,
      ),
      tool(
        "novel_items_submit_draft",
        "使用 validationToken 提交物品批量草稿供作者审阅。每份草稿只能成功提交一次。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitItemDraftHandler,
      ),
      tool(
        "novel_items_get_proposal_status",
        "从磁盘确认物品批量提案是否真实存在及其待审、已创建、已拒绝数量。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getItemProposalStatusHandler,
      ),
      tool(
        "novel_manuscript_get_context",
        "读取正文目录、指定章节全文、章节 sourceHash 和关联剧情计划。正文 AI 创建草稿前必须先读取当前章节。",
        { chapterId: z.string().regex(ID_PATTERN).optional() },
        getManuscriptContextHandler,
      ),
      tool(
        "novel_manuscript_create_draft",
        "创建绑定章节正文 sourceHash 和处理范围的可恢复正文草稿。草稿不会修改正式正文。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().trim().min(1).max(160),
          description: z.string().max(20_000).optional(),
          runId: z.string().regex(ID_PATTERN),
          chapterId: z.string().regex(ID_PATTERN),
          baseSourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
          mode: z.enum(["generate", "continue", "revise", "expand"]),
          rangeStart: z.number().int().nonnegative(),
          rangeEnd: z.number().int().nonnegative(),
        },
        createManuscriptDraftHandler,
      ),
      tool(
        "novel_manuscript_get_draft",
        "读取正文 AI 草稿状态。默认只返回正文与候选大小、哈希；确实需要全文时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getManuscriptDraftHandler,
      ),
      tool(
        "novel_manuscript_upsert_candidate",
        "向正文草稿分块写入候选正文。默认替换候选；传 append=true 可把小块追加到同一 candidateId，单次最多 64 KB、累计最多 4 MiB。不要包含解释或 Markdown 围栏。",
        {
          draftId: z.string().regex(ID_PATTERN),
          candidateId: z.string().regex(ID_PATTERN),
          content: z.string().min(1).max(MAX_INCREMENTAL_BATCH_BYTES),
          append: z.boolean().optional(),
        },
        upsertManuscriptCandidateHandler,
      ),
      tool(
        "novel_manuscript_validate_draft",
        "校验正文草稿的事实源版本、处理范围和候选内容；成功后返回 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateManuscriptDraftHandler,
      ),
      tool(
        "novel_manuscript_submit_draft",
        "使用 validationToken 提交正文候选到右侧差异审阅区。不会直接修改正式正文。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitManuscriptDraftHandler,
      ),
      tool(
        "novel_manuscript_get_proposal_status",
        "确认正文候选是否已提交，以及当前待审、已应用或已拒绝状态。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getManuscriptProposalStatusHandler,
      ),
      tool(
        "novel_factions_get_context",
        "读取已保存的势力组织事实；可按 factionId 限定单个势力。该工具只读。",
        { factionId: z.string().regex(ID_PATTERN).optional() },
        getFactionContextHandler,
      ),
      tool(
        "novel_factions_create_draft",
        "创建可恢复的势力组织草稿，用于生成待作者审阅的势力提案。草稿不写入正式势力库。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
        },
        createFactionDraftHandler,
      ),
      tool(
        "novel_factions_get_draft",
        "读取势力组织草稿状态。默认返回摘要；确实需要完整候选时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getFactionDraftHandler,
      ),
      tool(
        "novel_factions_upsert_draft_operations",
        "按候选 id 增量新增或替换势力候选；可分批生成，不需要一次提供整批势力。",
        {
          draftId: z.string().regex(ID_PATTERN),
          operations: z
            .array(
              z.object({
                candidateId: z.string().regex(ID_PATTERN),
                kind: z.literal("faction"),
                action: z.enum(["create", "update"]),
                targetId: z.string().regex(ID_PATTERN).optional(),
                summary: z.string().min(1).max(500),
                value: z.record(z.string(), z.unknown()),
              }),
            )
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertFactionDraftOperationsHandler,
      ),
      tool(
        "novel_factions_validate_draft",
        "校验势力草稿的势力名称、id 与角色/物品/空间节点引用；成功后返回 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateFactionDraftHandler,
      ),
      tool(
        "novel_factions_submit_draft",
        "使用 validationToken 创建待作者审批的势力提案。不会修改正式势力库。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitFactionDraftHandler,
      ),
      tool(
        "novel_factions_get_proposal_status",
        "从磁盘确认势力提案是否真实存在及其待审、已采纳、已拒绝数量。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getFactionProposalStatusHandler,
      ),
      tool(
        "novel_continuity_get_context",
        "读取正文连续性状态和状态批次摘要，供正文生成判断人物状态、关系、物品、地点和未结事项。默认不展开批次中的证据和回滚快照；传 chapterId 可筛选章节批次，确需详情时再传 batchId 读取单个完整批次。返回账本目录 sourceHash。该工具只读。",
        {
          chapterId: z
            .string()
            .regex(/^chapter-[0-9]{6}$/u)
            .optional(),
          batchId: z.string().regex(ID_PATTERN).optional(),
        },
        getContinuityContextHandler,
      ),
      tool(
        "novel_timeline_get_context",
        "按总览、事件、纪元或分支范围读取已保存的时间线事实。默认只返回总览；需要完整字段时指定 scope，必要时用 ids 限定对象。",
        {
          scope: z
            .enum(["overview", "events", "periods", "branches", "all"])
            .optional(),
          ids: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
        },
        getTimelineContextHandler,
      ),
      tool(
        "novel_timeline_create_draft",
        "创建可恢复的时间线草稿，用于生成待作者审阅的事件提案。草稿不写入正式时间线。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
        },
        createTimelineDraftHandler,
      ),
      tool(
        "novel_timeline_get_draft",
        "读取时间线草稿状态。默认返回摘要；确实需要完整候选时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getTimelineDraftHandler,
      ),
      tool(
        "novel_timeline_upsert_draft_operations",
        "按候选 id 增量新增或替换时间线事件候选；可分批生成，不需要一次提供整批事件。",
        {
          draftId: z.string().regex(ID_PATTERN),
          operations: z
            .array(
              z.object({
                candidateId: z.string().regex(ID_PATTERN),
                kind: z.literal("event"),
                action: z.enum(["create", "update"]),
                targetId: z.string().regex(ID_PATTERN).optional(),
                summary: z.string().min(1).max(500),
                value: z.record(z.string(), z.unknown()),
              }),
            )
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertTimelineDraftOperationsHandler,
      ),
      tool(
        "novel_timeline_validate_draft",
        "校验时间线草稿的事件标题、分支与角色/地点/章节/势力/物品引用；成功后返回 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateTimelineDraftHandler,
      ),
      tool(
        "novel_timeline_submit_draft",
        "使用 validationToken 创建待作者审批的时间线提案。不会修改正式时间线。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitTimelineDraftHandler,
      ),
      tool(
        "novel_timeline_get_proposal_status",
        "从磁盘确认时间线提案是否真实存在及其待审、已采纳、已拒绝数量。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getTimelineProposalStatusHandler,
      ),
      tool(
        "novel_maps_create_draft",
        "创建可恢复的世界地图草稿，用于生成待作者审阅的地图提案。草稿不写入正式地图库。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
        },
        createMapDraftHandler,
      ),
      tool(
        "novel_maps_get_draft",
        "读取世界地图草稿状态。默认返回摘要；确实需要完整候选时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getMapDraftHandler,
      ),
      tool(
        "novel_maps_generate_fantasy_map",
        "先用 novel_world_get_context 取得 sourceHash，再按 worldNodeId 及其后代读取当前小说世界架构的空间树、设定索引、Markdown、词条、地点聚合和势力聚合。worldSourceHash、陆块/区域/河流意图和所有 Azgaar 原生参数均为必填，缺少任一项会拒绝生成；Agent 必须根据范围内事实自己决定它们，不能让工具补猜。azgaarTemplate 只能使用工具 Schema 列出的内置高度图模板。若已配置独立 Azgaar Runtime，则把 sourceHash 校验后的世界快照交给 Runtime 并转换官方 JSON/GeoJSON，Runtime 调用或导出失败时自动保留诊断并生成设定驱动 compatibility-adapter 候选，否则明确使用 compatibility-adapter 候选。结果只写入地图草稿，不会直接修改正式地图；随后必须校验、提交并由作者审阅。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1).max(160).optional(),
          description: z.string().max(20_000).optional(),
          seed: z.string().max(200).optional(),
          mapName: z.string().max(120).optional(),
          width: z.number().int().min(240).max(100_000).optional(),
          height: z.number().int().min(240).max(100_000).optional(),
          layerId: z.string().regex(ID_PATTERN).optional(),
          worldNodeId: z.string().regex(ID_PATTERN).optional(),
          generationLevelTypeId: z.string().regex(ID_PATTERN).optional(),
          landmassCount: z
            .number()
            .int()
            .min(1)
            .max(4)
            .describe("Agent 根据世界架构决定的陆块数量意图"),
          regionCount: z
            .number()
            .int()
            .min(3)
            .max(12)
            .describe("Agent 根据地点、势力和空间层级决定的区域数量"),
          riverCount: z
            .number()
            .int()
            .min(2)
            .max(14)
            .describe("Agent 根据水系、气候和地貌决定的河流密度意图"),
          worldSourceHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .describe("必须原样传入 novel_world_get_context 返回的 sourceHash"),
          azgaarTemplate: z
            .enum(AZGAAR_HEIGHTMAP_TEMPLATES)
            .describe("Agent 选择的 Azgaar 原生高度图模板"),
          azgaarStates: z
            .number()
            .int()
            .min(0)
            .max(100)
            .describe("Agent 根据势力格局决定的 Azgaar 国家数"),
          azgaarCultures: z
            .number()
            .int()
            .min(1)
            .max(100)
            .describe("Agent 根据文明与族群设定决定的 Azgaar 文化数"),
          azgaarReligions: z
            .number()
            .int()
            .min(0)
            .max(50)
            .describe("Agent 根据宗教设定决定的 Azgaar 宗教数"),
          azgaarTemperatureEquator: z.number().min(20).max(35).optional(),
          azgaarTemperatureNorthPole: z.number().min(-40).max(10).optional(),
          azgaarTemperatureSouthPole: z.number().min(-40).max(10).optional(),
          azgaarPrecipitation: z
            .number()
            .min(0)
            .max(500)
            .describe("Agent 根据气候、水系和生境设定决定的年降水参数"),
        },
        generateFantasyMapHandler,
      ),
      tool(
        "novel_maps_upsert_draft_operations",
        "按候选 id 增量新增或替换地图候选；可分批生成，不需要一次提供整份地图。",
        {
          draftId: z.string().regex(ID_PATTERN),
          operations: z
            .array(
              z.object({
                candidateId: z.string().regex(ID_PATTERN),
                kind: z.literal("map"),
                action: z.enum(["create", "update"]),
                targetId: z.string().regex(ID_PATTERN).optional(),
                summary: z.string().min(1).max(500),
                value: z.record(z.string(), z.unknown()),
              }),
            )
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertMapDraftOperationsHandler,
      ),
      tool(
        "novel_maps_validate_draft",
        "校验世界地图草稿的名称、投影类型、图层与要素结构；成功后返回 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateMapDraftHandler,
      ),
      tool(
        "novel_maps_submit_draft",
        "使用 validationToken 创建待作者审批的世界地图提案。不会修改正式地图库。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitMapDraftHandler,
      ),
      tool(
        "novel_maps_get_proposal_status",
        "从磁盘确认世界地图提案是否真实存在及其待审、已采纳、已拒绝数量。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getMapProposalStatusHandler,
      ),
      tool(
        "novel_narrative_get_context",
        "按总览、线路、故事弧、目录或章节范围读取已保存的剧情工程事实。默认只返回总览；需要完整字段时指定 scope，必要时用 ids 限定对象。",
        {
          scope: z
            .enum(["overview", "lines", "arcs", "outline", "chapters", "all"])
            .optional(),
          ids: z.array(z.string().regex(ID_PATTERN)).max(100).optional(),
        },
        getNarrativeContextHandler,
      ),
      tool(
        "novel_narrative_create_draft",
        "在作者明确要求创建线路、故事弧、卷篇组目录或章节与节后创建可恢复的剧情草稿。草稿只保存候选，不会写入正式剧情工程。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().trim().min(1).max(160),
          description: z.string().max(20_000).optional(),
          baseSourceHash: narrativeExpectedSourceHashSchema,
        },
        createNarrativeDraftHandler,
      ),
      tool(
        "novel_narrative_get_draft",
        "读取剧情工程 AI 草稿状态。默认返回候选计数与 ID；确实需要完整候选时才传 includeContent=true。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getNarrativeDraftHandler,
      ),
      tool(
        "novel_narrative_upsert_draft_lines",
        "向剧情工程草稿增量写入线路候选。补充既有线路时必须填写 targetId，系统会保留该线路 ID 并更新内容；省略 targetId 才会创建新线路。每条线路必须提供至少一个关键节点。",
        {
          draftId: z.string().regex(ID_PATTERN),
          lines: z
            .array(narrativeLineInputSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertNarrativeDraftLinesHandler,
      ),
      tool(
        "novel_narrative_upsert_draft_story_arcs",
        "向剧情工程草稿增量写入故事弧候选。补充既有故事弧时必须填写 targetId，系统会保留该故事弧 ID 并更新内容；省略 targetId 才会创建新故事弧。每条故事弧必须提供至少一个关键节点。",
        {
          draftId: z.string().regex(ID_PATTERN),
          arcs: z
            .array(narrativeStoryArcInputSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertNarrativeDraftArcsHandler,
      ),
      tool(
        "novel_narrative_upsert_draft_directories",
        "向剧情工程草稿增量写入卷、篇、组目录候选。父目录可引用同一草稿中的 candidateId 或已有目录稳定 ID；卷必须位于根层，篇必须归属于卷。不得用故事弧代替目录。",
        {
          draftId: z.string().regex(ID_PATTERN),
          directories: z
            .array(narrativeDirectoryInputSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertNarrativeDraftDirectoriesHandler,
      ),
      tool(
        "novel_narrative_upsert_draft_chapters",
        "向剧情工程草稿增量写入章节候选；每章必须包含至少一个节，节内可包含多个段规划。更新既有章、节、段时分别填写 targetId 以保留稳定 ID；新建时省略 targetId。directoryId、lineIds、arcIds 可引用同一草稿候选或已有稳定 ID。该工具不创建正文。",
        {
          draftId: z.string().regex(ID_PATTERN),
          chapters: z
            .array(narrativeChapterInputSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        upsertNarrativeDraftChaptersHandler,
      ),
      tool(
        "novel_narrative_validate_draft",
        "校验剧情草稿的候选 id、目录父子关系、章节目结构、关键节点关联及线路故事弧引用；成功后返回 validationToken。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateNarrativeDraftHandler,
      ),
      tool(
        "novel_narrative_submit_draft",
        "使用最近一次校验返回的 validationToken 提交剧情草稿为待审提案；只写 narrative/proposals，不修改正式剧情事实目录。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitNarrativeDraftHandler,
      ),
      tool(
        "novel_narrative_get_proposal_status",
        "从磁盘查询剧情提案是否真实存在及其线路、故事弧、目录、章节候选的待审、已采纳、已拒绝数量。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getNarrativeProposalStatusHandler,
      ),
      tool(
        "novel_knowledge_search",
        "在已保存小说事实源上执行可引用的知识检索。返回 sourceHash、命中片段和精确文件行号；结果不是事实副本，写入仍必须经过当前领域提案协议。",
        {
          query: z.string().trim().min(1).max(400),
          limit: z.number().int().min(1).max(30).optional(),
        },
        searchNovelKnowledgeHandler,
      ),
      tool(
        "novel_world_get_context",
        "读取小说工作台当前世界架构。默认返回 meta、空间树、设定索引、地点逻辑聚合和势力逻辑聚合；需要查看具体设定页面时传入受支持的设定库路径。地点和势力聚合分别由其根索引及 records 内部装配，模型不应读取或写入 records 路径。地图生成必须使用返回的 sourceHash；仅允许 world/setting-library/**、world/locations/index.json 与 world/factions/index.json；修行体系不得传入本工具，必须改用 novel_cultivation_get_context（事实源入口为 world/cultivation/index.json）。",
        { paths: z.array(z.string()).optional() },
        getContextHandler,
      ),
      tool(
        "novel_inspiration_get_context",
        "读取已保存的灵感目录事实。根索引只返回条目摘要；传 focusId 才返回对应 records/<id>.json 的完整内容。返回覆盖根索引和已读取记录的 sourceHash。该工具只读。",
        {
          focusId: z.string().trim().min(1).max(200).optional(),
        },
        getInspirationContextHandler,
      ),
      tool(
        "novel_world_validate_changes",
        "校验世界架构与地点变更的路径、JSON、层级引用、地点层级、模板关联和设定文件闭合性。提交提案前必须调用。",
        {
          changes: z.array(changeSchema).min(1).max(MAX_INCREMENTAL_OPERATIONS),
        },
        validateHandler,
      ),
      tool(
        "novel_world_submit_proposal",
        "提交待审批的世界架构提案。该工具只写 proposals 快照，不会修改正式设定；正式写入只能由作者在审批界面执行。",
        {
          proposalId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          changes: z.array(changeSchema).min(1).max(MAX_INCREMENTAL_OPERATIONS),
        },
        submitHandler,
      ),
      tool(
        "novel_items_get_context",
        "读取小说物品库的分类、分类字段和已有物品摘要。确定目标分类后传 categoryId，可获得该分类继承后的有效字段。",
        { categoryId: z.string().regex(ID_PATTERN).optional() },
        getItemContextHandler,
      ),
      tool(
        "novel_items_validate_batch",
        "校验批量物品候选的目标分类、名称重复、字段类型、选项和必填值。提交物品提案前必须调用。",
        {
          categoryId: z.string().regex(ID_PATTERN),
          items: z.array(itemBatchCandidateSchema).min(1).max(MAX_BATCH_ITEMS),
        },
        validateItemBatchHandler,
      ),
      tool(
        "novel_items_submit_batch",
        "提交待审批的批量物品提案。该工具只写 proposals 候选，不会创建正式物品；正式创建只能由作者在物品库审批界面执行。",
        {
          proposalId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          categoryId: z.string().regex(ID_PATTERN),
          items: z.array(itemBatchCandidateSchema).min(1).max(MAX_BATCH_ITEMS),
        },
        submitItemBatchHandler,
      ),
      tool(
        "novel_characters_get_context",
        "读取人物库中的种族、角色分组、角色灵魂、物品库摘要和角色摘要；传 characterId 时返回完整角色卡。",
        { characterId: z.string().regex(ID_PATTERN).optional() },
        getCharacterContextHandler,
      ),
      tool(
        "novel_cultivation_get_context",
        "读取修行体系事实源。省略 systemId 返回体系与本源摘要；传 systemId 后可用 scope 按 theory、progression、resources、methods、abilities、formations、foundations、transitions 或 constraints 分模块读取，避免一次返回过大。返回绑定当前事实源的 sourceHash 和审计结果。该工具只读，不会修改正式设定。",
        {
          systemId: z.string().regex(ID_PATTERN).optional(),
          scope: z
            .enum([
              "all",
              "theory",
              "progression",
              "resources",
              "methods",
              "abilities",
              "formations",
              "foundations",
              "transitions",
              "constraints",
            ])
            .optional(),
        },
        getCultivationContextHandler,
      ),
      tool(
        "novel_cultivation_create_draft",
        "创建绑定当前事实源的可恢复修行体系草稿。草稿只保存候选生态 JSON，不会修改正式文件。",
        {
          draftId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().trim().min(1).max(160),
          description: z.string().max(20_000).optional(),
          baseSourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
        },
        createCultivationDraftHandler,
      ),
      tool(
        "novel_cultivation_get_draft",
        "读取修行体系草稿状态。默认只返回标题、版本、大小和哈希；只有确实需要原文时才传 includeContent=true，避免把整份大 JSON 放入上下文。",
        {
          draftId: z.string().regex(ID_PATTERN),
          includeContent: z.boolean().optional(),
        },
        getCultivationDraftHandler,
      ),
      tool(
        "novel_cultivation_upsert_draft",
        "小内容整份替换接口（最大 64 KB）：仅用于确实需要整体替换的小草稿。常规编辑必须使用 novel_cultivation_patch_draft，超过限制会要求分批写入。不会直接写入正式事实源；更新后必须重新校验。",
        {
          draftId: z.string().regex(ID_PATTERN),
          content: z.string().min(2).max(MAX_CULTIVATION_PATCH_BYTES),
        },
        upsertCultivationDraftHandler,
      ),
      tool(
        "novel_cultivation_patch_draft",
        "按稳定 ID 对修行体系草稿做小批量增量修改。merge 修改目标对象字段但不能修改对象自身 id，append 追加新对象，remove 删除对象；每次最多 32 项、64 KB。超过限制必须拆成多次调用。不会直接写入正式事实源，完成后必须调用 novel_cultivation_validate_draft。",
        {
          draftId: z.string().regex(ID_PATTERN),
          operations: z
            .array(
              z.discriminatedUnion("action", [
                z.object({
                  action: z.literal("merge"),
                  targetId: z.string().regex(ID_PATTERN),
                  fields: z.record(z.string(), z.unknown()),
                }),
                z.object({
                  action: z.literal("append"),
                  collection: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
                  parentId: z.string().regex(ID_PATTERN).optional(),
                  value: z.unknown(),
                }),
                z.object({
                  action: z.literal("remove"),
                  targetId: z.string().regex(ID_PATTERN),
                }),
              ]),
            )
            .min(1)
            .max(MAX_CULTIVATION_PATCH_OPERATIONS),
        },
        patchCultivationDraftHandler,
      ),
      tool(
        "novel_cultivation_validate_draft",
        "校验修行生态草稿的 Schema、稳定 ID、引用关系和当前事实源版本；工具会自动规范化通过校验的 JSON，成功后返回 validationToken，无需重新上传整份内容。",
        { draftId: z.string().regex(ID_PATTERN) },
        validateCultivationDraftHandler,
      ),
      tool(
        "novel_cultivation_submit_draft",
        "使用 validationToken 提交修行体系草稿。工具只为实际变化的体系模块文件生成 before/after 提案，不修改正式事实源。",
        {
          draftId: z.string().regex(ID_PATTERN),
          validationToken: z.string().min(1),
        },
        submitCultivationDraftHandler,
      ),
      tool(
        "novel_cultivation_get_proposal_status",
        "从磁盘确认修行体系提案是否真实存在及其审批状态。",
        { proposalId: z.string().regex(ID_PATTERN) },
        getCultivationProposalStatusHandler,
      ),
      tool(
        "novel_characters_validate_proposal",
        "校验人物库候选的结构、种族/灵魂/分组/关系/物品引用闭合、重复 id 与人物卡必要字段。提交角色提案前必须调用。",
        {
          operations: z
            .array(characterProposalOperationSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        validateCharacterProposalHandler,
      ),
      tool(
        "novel_characters_submit_proposal",
        "提交待审批的角色、种族、角色分组和角色灵魂候选。该工具只写提案，不会修改正式人物库。",
        {
          proposalId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          operations: z
            .array(characterProposalOperationSchema)
            .min(1)
            .max(MAX_INCREMENTAL_OPERATIONS),
        },
        submitCharacterProposalHandler,
      ),
    ],
  });
}

export function configureNovelWorkbench(
  _env: Record<string, string>,
  runtime: { sessionId: string; workspace?: string },
): void {
  bindNovelWorkbenchRuntime(runtime);
}
