import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { dirname, join, resolve, sep } from "path";

import {
  characterGroupDefinitionSchema,
  characterRecordSchema,
  characterSoulDefinitionSchema,
  raceDefinitionSchema,
} from "../../shared/novel-character-library-schema";
import {
  powerCatalogSchema,
  powerConnectionsSchema,
  powerSystemIndexSchema,
  powerSystemMetaSchema,
  powerSystemRecordSchema,
  type PowerCatalog,
  type PowerConnections,
  type PowerSystemIndex,
  type PowerSystemMeta,
  type PowerSystemRecord,
} from "../../shared/novel-power-system-schema";
import { validatePowerSystemLibrary } from "../../shared/novel-power-system-validation";
import {
  bindNovelWorkbenchRuntime,
  getNovelWorkbenchContext,
  NOVEL_WORKBENCH_SDK_ADAPTER_ID,
  NOVEL_WORKBENCH_SDK_INSTRUCTIONS,
} from "../novel-workbench-context";
import type {
  PowerDraftCatalogEntityInput,
  PowerDraftConnectionInput,
  PowerDraftDesignBrief,
  PowerDraftOverviewPatch,
  PowerDraftProgressionInput,
  PowerDraftRemoveScope,
} from "../novel-power-draft";

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

type ItemFieldValue = string | number | boolean | string[] | null;

type ItemBatchCandidate = {
  name: string;
  aliases?: string[];
  tags?: string[];
  summary?: string;
  values?: Record<string, ItemFieldValue>;
  description?: string;
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
const LOCATION_LIBRARY_PATH = "world/locations/index.json";
const LOCATION_SNAPSHOT_PATH = "__locations/index.json";
const TARGET_PATTERN =
  /^(?:world\/setting-library\/(?:meta\.json|spatial-tree\.json|settings\.json|pages\/[a-z0-9-]+\/[a-z0-9-]+\.md|entries\/[a-z0-9-]+\/[a-z0-9-]+\.json)|world\/locations\/index\.json)$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_CHANGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const ITEM_LIBRARY_ROOT = "world/items";
const ITEM_PROPOSAL_ROOT = `${ITEM_LIBRARY_ROOT}/proposals`;
const MAX_BATCH_ITEMS = 20;
const MAX_ITEM_DESCRIPTION_BYTES = 512 * 1024;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const CHARACTER_LIBRARY_ROOT = "characters";
const CHARACTER_PROPOSAL_ROOT = `${CHARACTER_LIBRARY_ROOT}/proposals`;
const MAX_CHARACTER_OPERATIONS = 40;
const POWER_SYSTEM_ROOT = "world/power-systems";
const POWER_SYSTEM_PROPOSAL_ROOT = `${POWER_SYSTEM_ROOT}/proposals`;
const POWER_SYSTEM_TARGET_PATTERN =
  /^world\/power-systems\/(?:meta\.json|index\.json|catalog\.json|connections\.json|records\/[a-z0-9-]+\.json|pages\/[a-z0-9-]+\.md)$/;
const MAX_POWER_SYSTEM_CHANGES = 40;

type CharacterProposalOperation = {
  candidateId: string;
  kind: "character" | "race" | "group" | "soul";
  action: "create" | "update";
  targetId?: string;
  summary: string;
  value: Record<string, unknown>;
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
    const current = await readOptional(workspaceFile(workspace, targetPath));
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
    (await readOptional(workspaceFile(workspace, LOCATION_LIBRARY_PATH)));
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
  for (const setting of settingItems!) {
    if (!setting || typeof setting !== "object") continue;
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
    if (
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
    const { workspace, context } = requireWorkspace();
    if (context.mode !== "items") {
      throw new Error("当前受控会话不是物品库批量生产会话");
    }
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
  const [metaContent, indexContent, itemIndexContent, novelContent] =
    await Promise.all([
      readOptional(
        workspaceFile(workspace, `${CHARACTER_LIBRARY_ROOT}/library.json`),
      ),
      readOptional(
        workspaceFile(workspace, `${CHARACTER_LIBRARY_ROOT}/index.json`),
      ),
      readOptional(workspaceFile(workspace, `${ITEM_LIBRARY_ROOT}/index.json`)),
      readOptional(workspaceFile(workspace, "novel.json")),
    ]);
  if (metaContent === null || indexContent === null) {
    throw new Error("人物库尚未初始化，请先在小说工作台打开人物库");
  }
  const meta = objectValue(JSON.parse(metaContent), "人物库配置");
  const index = objectValue(JSON.parse(indexContent), "人物库索引");
  const races = arrayField(meta, "races");
  const groups = arrayField(meta, "groups");
  const souls = arrayField(meta, "souls");
  const characters = arrayField(index, "characters");
  if (!races || !groups || !souls || !characters) {
    throw new Error("人物库配置或索引缺少必要数组");
  }
  const novel = novelContent
    ? objectValue(JSON.parse(novelContent), "小说项目配置")
    : {};
  const itemIndex = itemIndexContent
    ? objectValue(JSON.parse(itemIndexContent), "物品库索引")
    : {};
  const items = arrayField(itemIndex, "items") ?? [];
  return { meta, index, races, groups, souls, characters, items, novel };
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
    map.set(id, next);
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
  return errors;
}

async function getCharacterContextHandler(args: {
  characterId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    if (context.mode !== "characters") {
      throw new Error("当前受控会话不是人物库设计会话");
    }
    const state = await readCharacterLibraryState(workspace);
    const selected = args.characterId
      ? (state.characters
          .map((item) => objectValue(item, "角色"))
          .find((item) => item.id === args.characterId) ?? null)
      : null;
    return result({
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

async function validateCharacterProposalHandler(args: {
  operations: CharacterProposalOperation[];
}): Promise<CallToolResult> {
  try {
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
    const { workspace, context } = requireWorkspace();
    const errors = await validateCharacterProposal(args.operations);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
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
    ]);
    for (const requested of args.paths ?? [])
      paths.add(normalizeTargetPath(requested));
    if (paths.size > 30) throw new Error("单次最多读取 30 个设定文件");
    const files: Record<string, string | null> = {};
    for (const path of paths)
      files[path] = await readOptional(workspaceFile(workspace, path));
    return result({ mode: context.mode, files });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateHandler(args: {
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  try {
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
    const { workspace, context } = requireWorkspace();
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
        const beforeContent = await fs.readFile(
          workspaceFile(workspace, targetPath),
          "utf8",
        );
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

function normalizePowerSystemTargetPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!POWER_SYSTEM_TARGET_PATTERN.test(normalized)) {
    throw new Error(`不允许的力量体系目标路径：${value}`);
  }
  return normalized;
}

function powerSystemProposalSnapshotRelativePath(targetPath: string): string {
  return targetPath.slice(`${POWER_SYSTEM_ROOT}/`.length);
}

type SchemaResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: {
        issues: readonly { path: readonly PropertyKey[]; message: string }[];
      };
    };

function parsePowerSystemSchema<T>(
  path: string,
  content: string,
  schema: { safeParse(value: unknown): SchemaResult<T> },
  errors: string[],
): T | null {
  const value = parseJson(path, content, errors);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    errors.push(
      ...parsed.error.issues.map(
        (issue) =>
          `${path} ${issue.path.map(String).join(".") || "$"}：${issue.message}`,
      ),
    );
    return null;
  }
  return parsed.data;
}

async function validatePowerSystemChanges(
  changes: ProposedChange[],
): Promise<string[]> {
  const { workspace } = requireWorkspace();
  const errors: string[] = [];
  if (changes.length === 0) return ["至少需要一项力量体系变更"];
  if (changes.length > MAX_POWER_SYSTEM_CHANGES) {
    return [`单次最多提交 ${MAX_POWER_SYSTEM_CHANGES} 项力量体系变更`];
  }

  const ids = new Set<string>();
  const targets = new Set<string>();
  const proposed = new Map<string, string>();
  let totalBytes = 0;
  for (const change of changes) {
    let targetPath: string;
    try {
      targetPath = normalizePowerSystemTargetPath(change.targetPath);
    } catch (error) {
      errors.push(message(error));
      continue;
    }
    if (!ID_PATTERN.test(change.id) || ids.has(change.id)) {
      errors.push(`力量体系变更包含非法或重复 id：${change.id}`);
    }
    if (targets.has(targetPath)) {
      errors.push(`同一提案不能重复修改：${targetPath}`);
    }
    ids.add(change.id);
    targets.add(targetPath);
    proposed.set(targetPath, change.content);
    const bytes = Buffer.byteLength(change.content, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_CHANGE_BYTES) {
      errors.push(`${targetPath} 超过单文件大小限制`);
    }
    if (!change.summary.trim()) {
      errors.push(`${targetPath} 缺少变更摘要`);
    }
    const current = await readOptional(workspaceFile(workspace, targetPath));
    if (change.operation === "create" && current !== null) {
      errors.push(`新增目标已存在：${targetPath}`);
    }
    if (change.operation === "modify" && current === null) {
      errors.push(`修改目标不存在：${targetPath}`);
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    errors.push("力量体系提案总大小超过限制");
  }

  const candidateContent = async (path: string): Promise<string | null> =>
    proposed.has(path)
      ? (proposed.get(path) ?? null)
      : readOptional(workspaceFile(workspace, path));
  const metaPath = `${POWER_SYSTEM_ROOT}/meta.json`;
  const indexPath = `${POWER_SYSTEM_ROOT}/index.json`;
  const catalogPath = `${POWER_SYSTEM_ROOT}/catalog.json`;
  const connectionsPath = `${POWER_SYSTEM_ROOT}/connections.json`;
  const [metaContent, indexContent, catalogContent, connectionsContent] =
    await Promise.all([
      candidateContent(metaPath),
      candidateContent(indexPath),
      candidateContent(catalogPath),
      candidateContent(connectionsPath),
    ]);
  if (metaContent === null) errors.push("力量体系库缺少 meta.json");
  if (indexContent === null) errors.push("力量体系库缺少 index.json");
  if (catalogContent === null) errors.push("力量体系库缺少 catalog.json");
  if (connectionsContent === null)
    errors.push("力量体系库缺少 connections.json");
  if (
    metaContent === null ||
    indexContent === null ||
    catalogContent === null ||
    connectionsContent === null
  ) {
    return errors;
  }

  const meta = parsePowerSystemSchema<PowerSystemMeta>(
    metaPath,
    metaContent,
    powerSystemMetaSchema,
    errors,
  );
  const index = parsePowerSystemSchema<PowerSystemIndex>(
    indexPath,
    indexContent,
    powerSystemIndexSchema,
    errors,
  );
  const catalog = parsePowerSystemSchema<PowerCatalog>(
    catalogPath,
    catalogContent,
    powerCatalogSchema,
    errors,
  );
  const connections = parsePowerSystemSchema<PowerConnections>(
    connectionsPath,
    connectionsContent,
    powerConnectionsSchema,
    errors,
  );
  if (!meta || !index || !catalog || !connections) return errors;

  const typeIds = new Set<string>();
  for (const type of meta.systemTypes) {
    if (typeIds.has(type.id)) errors.push(`力量体系类型 id 重复：${type.id}`);
    typeIds.add(type.id);
  }

  const systemIds = new Set<string>();
  const records = new Map<string, PowerSystemRecord>();
  for (const entry of index.systems) {
    if (systemIds.has(entry.id)) {
      errors.push(`力量体系索引 id 重复：${entry.id}`);
      continue;
    }
    systemIds.add(entry.id);
    if (!typeIds.has(entry.typeId)) {
      errors.push(`力量体系“${entry.name}”引用了不存在的类型：${entry.typeId}`);
    }
    const expectedRecordPath = `${POWER_SYSTEM_ROOT}/records/${entry.id}.json`;
    const expectedPagePath = `${POWER_SYSTEM_ROOT}/pages/${entry.id}.md`;
    if (entry.recordPath !== expectedRecordPath) {
      errors.push(`力量体系“${entry.name}”的记录路径与 id 不一致`);
    }
    if (entry.pagePath !== expectedPagePath) {
      errors.push(`力量体系“${entry.name}”的说明路径与 id 不一致`);
    }
    const [recordContent, pageContent] = await Promise.all([
      candidateContent(expectedRecordPath),
      candidateContent(expectedPagePath),
    ]);
    if (recordContent === null) {
      errors.push(`力量体系“${entry.name}”缺少结构化记录`);
      continue;
    }
    if (pageContent === null) {
      errors.push(`力量体系“${entry.name}”缺少说明页`);
    }
    const record = parsePowerSystemSchema<PowerSystemRecord>(
      expectedRecordPath,
      recordContent,
      powerSystemRecordSchema,
      errors,
    );
    if (!record) continue;
    records.set(entry.id, record);
    if (record.id !== entry.id) {
      errors.push(`力量体系索引与记录 id 不一致：${entry.id}`);
    }
    if (
      record.name !== entry.name ||
      record.typeId !== entry.typeId ||
      record.status !== entry.status ||
      record.summary !== entry.summary ||
      record.updatedAt !== entry.updatedAt
    ) {
      errors.push(`力量体系“${entry.name}”的索引摘要与记录不一致`);
    }
    if (!typeIds.has(record.typeId)) {
      errors.push(`力量体系“${record.name}”引用了不存在的类型`);
    }
  }

  for (const path of proposed.keys()) {
    const recordMatch =
      /^world\/power-systems\/records\/([a-z0-9-]+)\.json$/.exec(path);
    const pageMatch = /^world\/power-systems\/pages\/([a-z0-9-]+)\.md$/.exec(
      path,
    );
    const referencedId = recordMatch?.[1] ?? pageMatch?.[1];
    if (referencedId && !systemIds.has(referencedId)) {
      errors.push(`提案文件未被最终 index.json 引用：${path}`);
    }
  }

  errors.push(
    ...validatePowerSystemLibrary({
      meta,
      index,
      catalog,
      connections,
      records,
    }),
  );
  return errors;
}

async function getPowerSystemContextHandler(args: {
  systemId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const [metaContent, indexContent, catalogContent, connectionsContent] =
      await Promise.all([
        fs.readFile(workspaceFile(workspace, `${POWER_SYSTEM_ROOT}/meta.json`), "utf8"),
        fs.readFile(workspaceFile(workspace, `${POWER_SYSTEM_ROOT}/index.json`), "utf8"),
        fs.readFile(workspaceFile(workspace, `${POWER_SYSTEM_ROOT}/catalog.json`), "utf8"),
        fs.readFile(
          workspaceFile(workspace, `${POWER_SYSTEM_ROOT}/connections.json`),
          "utf8",
        ),
      ]);
    const meta = powerSystemMetaSchema.parse(JSON.parse(metaContent));
    const index = powerSystemIndexSchema.parse(JSON.parse(indexContent));
    const catalog = powerCatalogSchema.parse(JSON.parse(catalogContent));
    const connections = powerConnectionsSchema.parse(
      JSON.parse(connectionsContent),
    );
    const powerDrafts = await import("../novel-power-draft");
    const drafts = await powerDrafts.listPowerDrafts(workspace);
    let selectedSystem: {
      record: PowerSystemRecord;
      pageMarkdown: string | null;
    } | null = null;
    if (args.systemId) {
      if (!ID_PATTERN.test(args.systemId)) {
        throw new Error("systemId 只能使用小写字母、数字和连字符");
      }
      const recordPath = `${POWER_SYSTEM_ROOT}/records/${args.systemId}.json`;
      const pagePath = `${POWER_SYSTEM_ROOT}/pages/${args.systemId}.md`;
      const recordContent = await fs.readFile(
        workspaceFile(workspace, recordPath),
        "utf8",
      );
      selectedSystem = {
        record: powerSystemRecordSchema.parse(JSON.parse(recordContent)),
        pageMarkdown: await readOptional(workspaceFile(workspace, pagePath)),
      };
    }
    const catalogEntities = [
      ...catalog.foundations,
      ...catalog.mediums,
      ...catalog.principles,
      ...catalog.resources,
      ...catalog.theories,
      ...catalog.methods,
      ...catalog.capabilities,
    ].map(({ id, name, kind, summary, tags }) => ({
      id,
      name,
      kind,
      summary,
      tags,
    }));
    return result({
      mode: context.mode,
      workflow: [
        "先用 novel_power_get_context 了解现状并与作者确认设计摘要",
        "用 novel_power_create_draft 创建服务端草稿",
        "按需调用 overview/catalog/progression/connections 增量工具",
        "用 novel_power_validate_draft 获取绑定当前版本的 validationToken",
        "用 novel_power_submit_draft 提交一次",
        "用 novel_power_get_proposal_status 确认 exists=true",
      ],
      systemTypes: meta.systemTypes,
      systems: index.systems,
      catalogEntities,
      connections: connections.connections.map(
        ({ id, kind, source, target, note }) => ({
          id,
          kind,
          source,
          target,
          note,
        }),
      ),
      drafts,
      selectedSystem,
      modelingPatterns: [
        {
          id: "trained-progression",
          fit: "修炼、魔法学习、武技、职业训练",
          emphasis: "理论模型、发展方法、资源需求、状态与转换",
        },
        {
          id: "event-awakening",
          fit: "异能觉醒、血脉、变异、神授",
          emphasis: "触发事件、状态条件、能力准入、代价与失控风险",
        },
        {
          id: "authority-permission",
          fit: "神权、契约、规则权限、社会制度型力量",
          emphasis: "底层法则、权限状态、授权条件与例外边界",
        },
        {
          id: "equipment-technology",
          fit: "科技、装备、改造、外部装置",
          emphasis: "介质、资源、版本路径、能力效果与系统交互",
        },
        {
          id: "soft-mysterious",
          fit: "神秘力量、寓言规则、不可完全解释的奇幻",
          emphasis: "保持局部一致，只定义叙事需要的边界和反例",
        },
      ],
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

type StructuredPowerValidationIssue = {
  code: "schema" | "reference" | "conflict" | "limit" | "invalid";
  path: string;
  message: string;
  suggestion: string;
};

const MAX_RETURNED_POWER_VALIDATION_ISSUES = 20;

function structurePowerValidationIssue(
  error: string,
): StructuredPowerValidationIssue {
  const filePath =
    /^(world\/power-systems\/[^\s：]+)/u.exec(error)?.[1] ?? "$";
  const fieldPath =
    /^world\/power-systems\/[^\s：]+\s+([^：]+)：/u.exec(error)?.[1];
  const path = fieldPath ? `${filePath}#${fieldPath}` : filePath;
  const code = /引用|不存在|未被.*引用|不一致/u.test(error)
    ? "reference"
    : /重复|已经存在|不能按|不能从/u.test(error)
      ? "conflict"
      : /超过|最多|大小限制/u.test(error)
        ? "limit"
        : filePath !== "$" && error.includes("：")
          ? "schema"
          : "invalid";
  const suggestion =
    code === "reference"
      ? "先读取当前上下文或草稿，使用已有稳定 id，并补齐对应目录对象或连接。"
      : code === "conflict"
        ? "为新对象使用唯一稳定 id；修改已有对象时保持原 kind 和目标体系。"
        : code === "limit"
          ? "缩小本次草稿范围，删除无叙事作用的冗余对象后重新校验。"
          : code === "schema"
            ? "使用对应领域 upsert 工具补齐该字段，不要手写完整文件。"
            : "读取草稿摘要，修正列出的对象后再次调用校验工具。";
  return { code, path, message: error, suggestion };
}

function structuredPowerValidationResult(errors: readonly string[]) {
  return {
    valid: errors.length === 0,
    totalErrorCount: errors.length,
    errors: errors
      .slice(0, MAX_RETURNED_POWER_VALIDATION_ISSUES)
      .map(structurePowerValidationIssue),
    truncated: errors.length > MAX_RETURNED_POWER_VALIDATION_ISSUES,
  };
}

async function createPowerDraftHandler(args: {
  draftId?: string;
  systemId: string;
  name: string;
  typeId: string;
  summary?: string;
  designBrief: PowerDraftDesignBrief;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    if (!context.sessionId) throw new Error("当前会话缺少稳定 sessionId");
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.createPowerDraft(workspace, args, {
      sessionId: context.sessionId,
      promptId: context.promptId,
      promptVersion: context.promptVersion,
    });
    return result({
      created: true,
      draft: powerDrafts.summarizePowerDraft(draft),
      nextAction: "按需增量写入目录对象、成长路径和连接；完成后校验草稿。",
    });
  } catch (error) {
    return result({ created: false, error: message(error) }, true);
  }
}

async function getPowerDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.loadPowerDraft(workspace, args.draftId);
    return result({
      draft,
      summary: powerDrafts.summarizePowerDraft(draft),
    });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function updatePowerDraftOverviewHandler(args: {
  draftId: string;
  patch: PowerDraftOverviewPatch;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.updatePowerDraftOverview(
      workspace,
      args.draftId,
      args.patch,
    );
    return result({ updated: true, draft: powerDrafts.summarizePowerDraft(draft) });
  } catch (error) {
    return result({ updated: false, error: message(error) }, true);
  }
}

async function upsertPowerDraftCatalogHandler(args: {
  draftId: string;
  entities: PowerDraftCatalogEntityInput[];
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.upsertPowerDraftCatalogEntities(
      workspace,
      args.draftId,
      args.entities,
    );
    return result({ updated: true, draft: powerDrafts.summarizePowerDraft(draft) });
  } catch (error) {
    return result({ updated: false, error: message(error) }, true);
  }
}

async function upsertPowerDraftProgressionHandler(args: {
  draftId: string;
  progression: PowerDraftProgressionInput;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.upsertPowerDraftProgression(
      workspace,
      args.draftId,
      args.progression,
    );
    return result({ updated: true, draft: powerDrafts.summarizePowerDraft(draft) });
  } catch (error) {
    return result({ updated: false, error: message(error) }, true);
  }
}

async function upsertPowerDraftConnectionsHandler(args: {
  draftId: string;
  connections: PowerDraftConnectionInput[];
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.upsertPowerDraftConnections(
      workspace,
      args.draftId,
      args.connections,
    );
    return result({ updated: true, draft: powerDrafts.summarizePowerDraft(draft) });
  } catch (error) {
    return result({ updated: false, error: message(error) }, true);
  }
}

async function removePowerDraftEntitiesHandler(args: {
  draftId: string;
  scope: PowerDraftRemoveScope;
  ids: string[];
  trackId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.removePowerDraftEntities(
      workspace,
      args.draftId,
      args.scope,
      args.ids,
      args.trackId,
    );
    return result({ updated: true, draft: powerDrafts.summarizePowerDraft(draft) });
  } catch (error) {
    return result({ updated: false, error: message(error) }, true);
  }
}

async function validatePowerDraftHandler(args: {
  draftId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const draft = await powerDrafts.loadPowerDraft(workspace, args.draftId);
    if (draft.submittedProposalId) {
      throw new Error(`该草稿已经提交：${draft.submittedProposalId}`);
    }
    const materialized = await powerDrafts.materializePowerDraftChanges(
      workspace,
      draft,
    );
    const errors = await validatePowerSystemChanges(materialized.changes);
    if (errors.length > 0) {
      return result(structuredPowerValidationResult(errors), true);
    }
    const validated = await powerDrafts.savePowerDraftValidation(
      workspace,
      draft,
      materialized.contentHash,
    );
    return result({
      valid: true,
      totalErrorCount: 0,
      errors: [],
      validationToken: validated.validation?.token,
      contentHash: materialized.contentHash,
      revision: validated.revision,
      changeCount: materialized.changes.length,
      nextAction: "使用完全相同的 validationToken 调用 novel_power_submit_draft。",
    });
  } catch (error) {
    const errors = [message(error)];
    return result(structuredPowerValidationResult(errors), true);
  }
}

async function persistPowerSystemProposal(args: {
  proposalId: string;
  title: string;
  description?: string;
  changes: ProposedChange[];
}): Promise<{ proposalId: string; changeCount: number }> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    const { workspace, context } = requireWorkspace();
    const proposalId = args.proposalId.trim();
    if (!ID_PATTERN.test(proposalId)) {
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    }
    const proposalsDirectory = workspaceFile(
      workspace,
      POWER_SYSTEM_PROPOSAL_ROOT,
    );
    proposalDirectory = workspaceFile(
      workspace,
      `${POWER_SYSTEM_PROPOSAL_ROOT}/${proposalId}`,
    );
    await fs.mkdir(proposalsDirectory, { recursive: true });
    await fs.mkdir(proposalDirectory);
    createdProposalDirectory = true;

    const manifestChanges = [];
    for (const change of args.changes) {
      const targetPath = normalizePowerSystemTargetPath(change.targetPath);
      const relativePath = powerSystemProposalSnapshotRelativePath(targetPath);
      const afterPath = join(
        proposalDirectory,
        "after",
        ...relativePath.split("/"),
      );
      await fs.mkdir(dirname(afterPath), { recursive: true });
      await fs.writeFile(afterPath, change.content, {
        encoding: "utf8",
        flag: "wx",
      });
      if (change.operation === "modify") {
        const beforeContent = await fs.readFile(
          workspaceFile(workspace, targetPath),
          "utf8",
        );
        const beforePath = join(
          proposalDirectory,
          "before",
          ...relativePath.split("/"),
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
    return { proposalId, changeCount: manifestChanges.length };
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    throw error;
  }
}

async function submitPowerDraftHandler(args: {
  draftId: string;
  validationToken: string;
  proposalId?: string;
  title: string;
  description?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    let draft = await powerDrafts.loadPowerDraft(workspace, args.draftId);
    if (draft.submittedProposalId) {
      const status = await powerDrafts.getPowerProposalStatus(
        workspace,
        draft.submittedProposalId,
      );
      return result(
        {
          submitted: status.exists,
          recovered: true,
          ...status,
          reviewAction: "请作者在小说工作台的力量体系页面点击“审阅提案”。",
        },
        !status.exists,
      );
    }
    const generatedProposalId = `proposal-${draft.draftId}`;
    const proposalId = args.proposalId?.trim() || generatedProposalId;
    const existingStatus = await powerDrafts.getPowerProposalStatus(
      workspace,
      proposalId,
    );
    if (existingStatus.exists) {
      if (args.proposalId) {
        throw new Error(`proposalId 已存在：${proposalId}`);
      }
      let draftLinked = false;
      if (
        draft.validation?.token === args.validationToken &&
        draft.validation.revision === draft.revision
      ) {
        try {
          draft = await powerDrafts.markPowerDraftSubmitted(
            workspace,
            draft,
            proposalId,
          );
          draftLinked = true;
        } catch {
          // The proposal is durable even if a concurrent draft edit won the race.
        }
      }
      return result({
        submitted: true,
        recovered: true,
        draftLinked,
        ...existingStatus,
        draft: powerDrafts.summarizePowerDraft(draft),
        ...(draftLinked
          ? {}
          : {
              warning:
                "提案已存在，但草稿在提交期间发生变化；请以提案状态为准。",
            }),
        reviewAction: "请作者在小说工作台的力量体系页面点击“审阅提案”。",
      });
    }
    if (!draft.validation || draft.validation.token !== args.validationToken) {
      throw new Error("validationToken 无效或已经因草稿修改而失效，请重新校验");
    }
    if (draft.validation.revision !== draft.revision) {
      throw new Error("草稿版本已变化，请重新校验");
    }
    const materialized = await powerDrafts.materializePowerDraftChanges(
      workspace,
      draft,
    );
    if (materialized.contentHash !== draft.validation.contentHash) {
      throw new Error("正式库或草稿内容在校验后发生变化，请重新校验");
    }
    const errors = await validatePowerSystemChanges(materialized.changes);
    if (errors.length > 0) {
      return result(
        { submitted: false, ...structuredPowerValidationResult(errors) },
        true,
      );
    }
    const persisted = await persistPowerSystemProposal({
      proposalId,
      title: args.title,
      description: args.description,
      changes: materialized.changes,
    });
    draft = await powerDrafts.markPowerDraftSubmitted(
      workspace,
      draft,
      persisted.proposalId,
    );
    const status = await powerDrafts.getPowerProposalStatus(
      workspace,
      persisted.proposalId,
    );
    if (!status.exists) {
      throw new Error("提案写入后未能从磁盘回查，请勿宣称提交成功");
    }
    return result({
      submitted: true,
      ...status,
      draft: powerDrafts.summarizePowerDraft(draft),
      reviewAction: "请作者在小说工作台的力量体系页面点击“审阅提案”。",
    });
  } catch (error) {
    return result({ submitted: false, error: message(error) }, true);
  }
}

async function getPowerProposalStatusHandler(args: {
  proposalId: string;
}): Promise<CallToolResult> {
  try {
    const { workspace } = requireWorkspace();
    const powerDrafts = await import("../novel-power-draft");
    const status = await powerDrafts.getPowerProposalStatus(
      workspace,
      args.proposalId,
    );
    return result(status, !status.exists);
  } catch (error) {
    return result(
      { exists: false, proposalId: args.proposalId, error: message(error) },
      true,
    );
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
    content: z.string(),
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
  });
  const characterProposalOperationSchema = z.object({
    candidateId: z.string().regex(ID_PATTERN),
    kind: z.enum(["character", "race", "group", "soul"]),
    action: z.enum(["create", "update"]),
    targetId: z.string().regex(ID_PATTERN).optional(),
    summary: z.string().min(1),
    value: z.record(z.string(), z.unknown()),
  });
  const powerIdSchema = z.string().regex(ID_PATTERN);
  const powerMetadataInputSchema = z.object({
    settingLevel: z.string().optional(),
    domainCategories: z.array(z.string().min(1)).optional(),
    spatialScopeIds: z.array(powerIdSchema).optional(),
    timeFrom: z.string().optional(),
    timeTo: z.string().optional(),
    authority: z.enum(["hard", "default", "exception", "rumor"]).optional(),
    canon: z.enum(["draft", "provisional", "canon", "deprecated"]).optional(),
    revealStage: z.string().optional(),
  });
  const powerDesignBriefSchema = z.object({
    narrativePurpose: z.string().min(1).describe("该体系在故事中解决什么叙事问题"),
    coreMechanism: z.string().min(1).describe("力量从何而来、通过什么机制产生效果"),
    progressionModel: z.string().min(1).describe("成长、觉醒、授权或版本变化的方式"),
    costs: z.array(z.string().min(1)).describe("获得、维持或使用力量的代价"),
    comparisonRule: z.string().min(1).describe("同体系及跨体系比较时采用的规则"),
    exceptionBoundaries: z.array(z.string().min(1)).describe("规则不适用的例外和边界"),
  });
  const powerDimensionSchema = z.object({
    id: powerIdSchema,
    name: z.string().min(1),
    category: z.enum(["quality", "boundary"]),
    measurement: z.enum(["numeric", "ordinal", "descriptive"]).optional(),
    unit: z.string().optional(),
    lowLabel: z.string().optional(),
    highLabel: z.string().optional(),
    description: z.string().optional(),
  });
  const powerOverviewPatchSchema = z.object({
    name: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).optional(),
    summary: z.string().optional(),
    status: z.enum(["draft", "active", "archived"]).optional(),
    designContract: z
      .object({
        explanation: z.enum(["explicit", "partial", "mysterious"]).optional(),
        progression: z
          .enum(["none", "single-track", "multi-track", "event-driven"])
          .optional(),
        costPolicy: z.enum(["required", "recommended", "optional"]).optional(),
        comparison: z.enum(["stable", "contextual", "incomparable"]).optional(),
        theoryPolicy: z.enum(["explicit", "partial", "unknown"]).optional(),
      })
      .optional(),
    dimensions: z.array(powerDimensionSchema).optional(),
    metadata: powerMetadataInputSchema.optional(),
    pageMarkdown: z.string().optional(),
  });
  const powerEntityReferenceSchema = z.discriminatedUnion("namespace", [
    z.object({
      namespace: z.literal("catalog"),
      kind: z.enum([
        "foundation",
        "medium",
        "principle",
        "resource",
        "theory",
        "method",
        "capability",
      ]),
      targetId: powerIdSchema,
    }),
    z.object({
      namespace: z.literal("system"),
      systemId: powerIdSchema,
      kind: z.enum([
        "system",
        "track",
        "state",
        "transition",
        "quality-dimension",
        "boundary-dimension",
      ]),
      targetId: powerIdSchema,
    }),
    z.object({
      namespace: z.literal("external"),
      kind: z.enum(["actor", "location", "faction", "item", "event", "external"]),
      targetId: powerIdSchema,
    }),
  ]);
  const catalogEntityBaseShape = {
    id: powerIdSchema,
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).optional(),
    subtypeId: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    metadata: powerMetadataInputSchema.optional(),
  };
  const theoryOperationSchema = z.object({
    id: powerIdSchema,
    name: z.string().min(1),
    operationType: z.enum([
      "circulate",
      "aggregate",
      "compress",
      "refine",
      "split",
      "convert",
      "resonate",
      "synchronize",
      "encode",
      "inscribe",
      "project",
      "self-organize",
      "feedback",
      "sample",
      "custom",
    ]),
    input: z.string(),
    output: z.string(),
    rule: z.string(),
  });
  const theoryReferenceSchema = z.object({
    namespace: z.literal("catalog"),
    kind: z.literal("theory"),
    targetId: powerIdSchema,
  });
  const powerCatalogEntityInputSchema = z.discriminatedUnion("kind", [
    z.object({
      ...catalogEntityBaseShape,
      kind: z.literal("foundation"),
      details: z
        .object({
          foundationType: z
            .enum([
              "natural",
              "biological",
              "psychic",
              "divine",
              "technological",
              "social",
              "conceptual",
              "extradimensional",
              "unknown",
            ])
            .optional(),
          availability: z
            .enum([
              "universal",
              "regional",
              "innate",
              "granted",
              "manufactured",
              "institutional",
              "event-bound",
              "unknown",
            ])
            .optional(),
          manifestation: z.string().optional(),
        })
        .optional(),
    }),
    z.object({
      ...catalogEntityBaseShape,
      kind: z.literal("medium"),
      details: z
        .object({
          mediumType: z
            .enum([
              "energy",
              "substance",
              "field",
              "network",
              "body",
              "mind",
              "soul",
              "symbolic",
              "device",
              "authority",
              "environment",
              "unknown",
            ])
            .optional(),
          carrier: z.string().optional(),
          circulation: z.string().optional(),
          storage: z.string().optional(),
          loss: z.string().optional(),
        })
        .optional(),
    }),
    z.object({
      ...catalogEntityBaseShape,
      kind: z.literal("principle"),
      details: z
        .object({
          principleType: z
            .enum(["invariant", "prohibition", "boundary", "conversion", "priority", "axiom", "custom"])
            .optional(),
          scope: z.enum(["universe", "world", "domain", "system", "local"]).optional(),
          statements: z.array(z.string().min(1)).optional(),
          conditions: z.array(z.string().min(1)).optional(),
          exceptions: z.array(z.string().min(1)).optional(),
          priority: z.number().int().min(0).max(9999).optional(),
        })
        .optional(),
    }),
    z.object({
      ...catalogEntityBaseShape,
      kind: z.literal("resource"),
      details: z
        .object({
          resourceType: z
            .enum(["fuel", "material", "catalyst", "environment", "information", "permission", "emotion", "biological", "time", "other"])
            .optional(),
          measurement: z.enum(["numeric", "ordinal", "descriptive", "unknown"]).optional(),
          unit: z.string().optional(),
          qualityDimensions: z.array(z.string().min(1)).optional(),
          replenishment: z.string().optional(),
          scarcity: z.string().optional(),
        })
        .optional(),
    }),
    z.object({
      ...catalogEntityBaseShape,
      kind: z.literal("theory"),
      details: z
        .object({
          representationType: z
            .enum(["sequence", "graph", "modular", "spatial-field", "symbolic", "dynamic-system", "rule-system", "probabilistic", "embodied", "emotional", "unknown"])
            .optional(),
          substrateRefs: z.array(powerEntityReferenceSchema).optional(),
          topology: z
            .object({
              spatialDimensions: z.number().int().min(0).max(16).nullable(),
              nodeDefinition: z.string(),
              connectionDefinition: z.string(),
              structure: z.string(),
            })
            .optional(),
          operations: z.array(theoryOperationSchema).optional(),
          controlStrategy: z.string().optional(),
          complexity: z
            .object({
              memory: z.enum(["low", "medium", "high", "extreme", "unknown"]),
              parallelism: z.enum(["low", "medium", "high", "extreme", "unknown"]),
              abstraction: z.enum(["low", "medium", "high", "extreme", "unknown"]),
              dynamism: z.enum(["low", "medium", "high", "extreme", "unknown"]),
            })
            .optional(),
          assumptions: z.array(z.string().min(1)).optional(),
          invariants: z.array(z.string().min(1)).optional(),
          failureModes: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    }),
    z.object({
      ...catalogEntityBaseShape,
      kind: z.literal("method"),
      details: z
        .object({
          acquisition: z
            .enum(["training", "study", "inheritance", "awakening", "implantation", "contract", "ritual", "equipment", "authorization", "event", "unknown"])
            .optional(),
          roles: z
            .array(z.enum(["advance", "stabilize", "refine", "recover", "transform", "awaken", "control", "adapt"]))
            .optional(),
          theoryRefs: z.array(theoryReferenceSchema).optional(),
          procedure: z.string().optional(),
          phases: z
            .array(
              z.object({
                id: powerIdSchema,
                name: z.string().min(1),
                order: z.number().int().nonnegative(),
                goal: z.string(),
                operations: z.array(z.string().min(1)),
                requirements: z.array(z.string().min(1)),
                outputs: z.array(z.string().min(1)),
              }),
            )
            .optional(),
          outputs: z.array(z.string().min(1)).optional(),
          failureConsequences: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    }),
    z.object({
      ...catalogEntityBaseShape,
      kind: z.literal("capability"),
      details: z
        .object({
          capabilityType: z
            .enum(["intrinsic", "technique", "spell", "superpower", "sense", "transformation", "authority", "technology", "custom"])
            .optional(),
          activation: z
            .enum(["active", "passive", "conditional", "toggle", "ritual", "collective", "automatic"])
            .optional(),
          effect: z.string().optional(),
          target: z.string().optional(),
          range: z.string().optional(),
          duration: z.string().optional(),
          costs: z.array(z.string().min(1)).optional(),
          limitations: z.array(z.string().min(1)).optional(),
          sideEffects: z.array(z.string().min(1)).optional(),
          countermeasures: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    }),
  ]);
  const powerMetricValueInputSchema = z.object({
    dimensionId: powerIdSchema,
    value: z.union([z.number(), z.string(), z.null()]),
    note: z.string().optional(),
  });
  const powerStateInputSchema = z.object({
    id: powerIdSchema,
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).optional(),
    stateType: z.enum(["stage", "rank", "form", "control", "version", "permission", "condition", "custom"]).optional(),
    summary: z.string().optional(),
    order: z.number().int().nonnegative().optional(),
    entryConditions: z.array(z.string().min(1)).optional(),
    maintenanceConditions: z.array(z.string().min(1)).optional(),
    exitConditions: z.array(z.string().min(1)).optional(),
    baseQualities: z.array(powerMetricValueInputSchema).optional(),
    baseBoundaries: z.array(powerMetricValueInputSchema).optional(),
    cognition: z
      .object({
        representationType: z.enum(["sequence", "graph", "modular", "spatial-field", "symbolic", "dynamic-system", "rule-system", "probabilistic", "embodied", "emotional", "unknown"]).optional(),
        description: z.string().optional(),
        memoryLoad: z.enum(["low", "medium", "high", "extreme", "unknown"]).optional(),
        parallelism: z.enum(["low", "medium", "high", "extreme", "unknown"]).optional(),
        abstraction: z.enum(["low", "medium", "high", "extreme", "unknown"]).optional(),
        dynamism: z.enum(["low", "medium", "high", "extreme", "unknown"]).optional(),
        spatialDimensions: z.number().int().min(0).max(16).nullable().optional(),
        requiredSkills: z.array(z.string().min(1)).optional(),
        breakthroughInsight: z.string().optional(),
      })
      .optional(),
    stability: z.string().optional(),
    risks: z.array(z.string().min(1)).optional(),
    metadata: powerMetadataInputSchema.optional(),
  });
  const powerTransitionInputSchema = z.object({
    id: powerIdSchema,
    name: z.string().min(1),
    fromStateId: powerIdSchema.nullable().optional(),
    toStateId: powerIdSchema,
    transitionType: z.enum(["advance", "branch", "merge", "regress", "transform", "recover", "awaken", "event"]).optional(),
    conditions: z.array(z.string().min(1)).optional(),
    qualityCarryover: z.enum(["preserve", "reset", "transform", "partial", "custom"]).optional(),
    qualityRule: z.string().optional(),
    outcomes: z.array(z.string().min(1)).optional(),
    failureModes: z.array(z.string().min(1)).optional(),
    reversible: z.boolean().optional(),
  });
  const powerProgressionInputSchema = z.object({
    track: z.object({
      id: powerIdSchema,
      name: z.string().min(1).optional(),
      subtypeId: z.string().optional(),
      summary: z.string().optional(),
      mode: z.enum(["ordered", "branching", "coexisting", "cyclic", "threshold", "event-driven", "unordered"]).optional(),
      metadata: powerMetadataInputSchema.optional(),
    }),
    states: z.array(powerStateInputSchema).optional(),
    transitions: z.array(powerTransitionInputSchema).optional(),
  });
  const powerMetricModifierSchema = z.object({
    dimensionId: powerIdSchema,
    operation: z.enum(["set", "add", "multiply", "minimum", "maximum"]),
    value: z.union([z.number(), z.string()]),
    note: z.string(),
  });
  const powerConnectionBaseShape = {
    id: powerIdSchema,
    source: powerEntityReferenceSchema,
    target: powerEntityReferenceSchema,
    conditions: z.array(z.string().min(1)).optional(),
    note: z.string().optional(),
    metadata: powerMetadataInputSchema.optional(),
  };
  const powerConnectionInputSchema = z.discriminatedUnion("kind", [
    z.object({
      ...powerConnectionBaseShape,
      kind: z.literal("association"),
      details: z
        .object({
          relation: z.enum(["governs", "uses", "adopts", "expresses", "requires", "compatible-with", "counters", "forbidden-by", "depends-on", "converts-into"]).optional(),
          compatibility: z.enum(["native", "adapted", "conditional", "forbidden"]).optional(),
        })
        .optional(),
    }),
    z.object({
      ...powerConnectionBaseShape,
      kind: z.literal("method-application"),
      details: z
        .object({
          role: z.enum(["advance", "stabilize", "refine", "recover", "transform", "awaken", "control", "adapt"]).optional(),
          compatibility: z.enum(["native", "adapted", "conditional", "forbidden"]).optional(),
          theoryRef: theoryReferenceSchema.nullable().optional(),
          executionModel: z.string().optional(),
          efficiency: z
            .object({
              mode: z.enum(["qualitative", "multiplier", "formula"]),
              value: z.union([z.number(), z.string(), z.null()]),
              note: z.string(),
            })
            .optional(),
          qualityEffects: z.array(powerMetricModifierSchema).optional(),
          boundaryEffects: z.array(powerMetricModifierSchema).optional(),
          outcomes: z.array(z.string().min(1)).optional(),
          failureModes: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    }),
    z.object({
      ...powerConnectionBaseShape,
      kind: z.literal("resource-requirement"),
      details: z
        .object({
          purpose: z.enum(["develop", "advance", "maintain", "activate", "recover", "transform"]).optional(),
          amount: z
            .object({
              mode: z.enum(["numeric", "range", "rate", "descriptive"]),
              minimum: z.number().nullable(),
              maximum: z.number().nullable(),
              value: z.string(),
              unit: z.string(),
            })
            .optional(),
          quality: z.string().optional(),
          consumed: z.boolean().optional(),
          substituteRefs: z
            .array(
              z.object({
                namespace: z.literal("catalog"),
                kind: z.literal("resource"),
                targetId: powerIdSchema,
              }),
            )
            .optional(),
          shortageConsequence: z.string().optional(),
        })
        .optional(),
    }),
    z.object({
      ...powerConnectionBaseShape,
      kind: z.literal("capability-access"),
      details: z
        .object({
          accessMode: z.enum(["intrinsic", "learnable", "method-grant", "awakening", "equipped", "contracted", "authorized", "conditional", "forbidden"]).optional(),
          mastery: z.enum(["available", "basic", "proficient", "mastered", "variable"]).optional(),
        })
        .optional(),
    }),
    z.object({
      ...powerConnectionBaseShape,
      kind: z.literal("system-interaction"),
      details: z
        .object({
          interaction: z.enum(["compatible", "conversion", "suppression", "amplification", "interference", "exclusion", "fusion"]).optional(),
          effect: z.string().optional(),
        })
        .optional(),
    }),
  ]);
  return createSdkMcpServer({
    name: NOVEL_WORKBENCH_SDK_ADAPTER_ID,
    version: "1.0.0",
    instructions: NOVEL_WORKBENCH_SDK_INSTRUCTIONS,
    tools: [
      tool(
        "novel_world_get_context",
        "读取小说工作台当前世界架构。默认返回 meta、空间树、设定索引和地点索引；需要查看具体页面时传入受支持的项目相对路径。",
        { paths: z.array(z.string()).max(27).optional() },
        getContextHandler,
      ),
      tool(
        "novel_world_validate_changes",
        "校验世界架构与地点变更的路径、JSON、层级引用、地点层级、模板关联和设定文件闭合性。提交提案前必须调用。",
        { changes: z.array(changeSchema).min(1).max(100) },
        validateHandler,
      ),
      tool(
        "novel_world_submit_proposal",
        "提交待审批的世界架构提案。该工具只写 proposals 快照，不会修改正式设定；正式写入只能由作者在审批界面执行。",
        {
          proposalId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          changes: z.array(changeSchema).min(1).max(100),
        },
        submitHandler,
      ),
      tool(
        "novel_power_get_context",
        "读取精简的力量体系上下文、已有稳定 id、草稿列表和题材中立建模模式；传 systemId 时只额外读取该体系详情。每次设计必须先调用。",
        { systemId: z.string().regex(ID_PATTERN).optional() },
        getPowerSystemContextHandler,
      ),
      tool(
        "novel_power_create_draft",
        "在作者明确确认设计摘要后创建服务端力量体系草稿。该工具自动生成最小合法记录，不要求手写 index、record 或 page 文件。",
        {
          draftId: powerIdSchema.optional(),
          systemId: powerIdSchema,
          name: z.string().min(1),
          typeId: powerIdSchema,
          summary: z.string().optional(),
          designBrief: powerDesignBriefSchema,
        },
        createPowerDraftHandler,
      ),
      tool(
        "novel_power_get_draft",
        "读取一份力量体系草稿的完整领域对象和当前 revision。恢复会话或修复校验问题时使用。",
        { draftId: powerIdSchema },
        getPowerDraftHandler,
      ),
      tool(
        "novel_power_update_draft_overview",
        "增量更新力量体系草稿的名称、摘要、设计契约、质量/边界维度、元数据或说明页。未提供的字段保持不变。",
        {
          draftId: powerIdSchema,
          patch: powerOverviewPatchSchema,
        },
        updatePowerDraftOverviewHandler,
      ),
      tool(
        "novel_power_upsert_catalog",
        "增量新增或更新共享力量对象：本源、介质、法则、资源、理论、方法、能力。按稳定 id 合并，未提供的已有字段保持不变。",
        {
          draftId: powerIdSchema,
          entities: z.array(powerCatalogEntityInputSchema).min(1).max(30),
        },
        upsertPowerDraftCatalogHandler,
      ),
      tool(
        "novel_power_upsert_progression",
        "增量新增或更新一个成长路径及其状态、转换、认知要求、条件、基础质量和能力边界。状态不是固定境界，可表示等级、形态、版本、权限或条件。",
        {
          draftId: powerIdSchema,
          progression: powerProgressionInputSchema,
        },
        upsertPowerDraftProgressionHandler,
      ),
      tool(
        "novel_power_upsert_connections",
        "增量新增或更新领域连接，用于把方法、资源、能力应用到体系/状态/转换，或定义跨体系交互。引用必须使用上下文中的稳定 id。",
        {
          draftId: powerIdSchema,
          connections: z.array(powerConnectionInputSchema).min(1).max(50),
        },
        upsertPowerDraftConnectionsHandler,
      ),
      tool(
        "novel_power_remove_draft_entities",
        "仅从未提交草稿中删除误建的目录对象、成长路径、状态、转换或连接。不会删除正式库内容。",
        {
          draftId: powerIdSchema,
          scope: z.enum(["catalog", "track", "state", "transition", "connection"]),
          ids: z.array(powerIdSchema).min(1).max(50),
          trackId: powerIdSchema.optional(),
        },
        removePowerDraftEntitiesHandler,
      ),
      tool(
        "novel_power_validate_draft",
        "物化并完整校验草稿的 Schema、索引、引用、成长结构、指标和生态连接。成功后返回绑定当前 revision 与内容哈希的 validationToken。",
        { draftId: powerIdSchema },
        validatePowerDraftHandler,
      ),
      tool(
        "novel_power_submit_draft",
        "使用最近一次校验返回的 validationToken 提交草稿。提交前会重新物化、核对内容哈希并再次校验，只创建待审批快照。每份草稿只能成功提交一次。",
        {
          draftId: powerIdSchema,
          validationToken: z.string().min(1),
          proposalId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
        },
        submitPowerDraftHandler,
      ),
      tool(
        "novel_power_get_proposal_status",
        "从磁盘查询力量体系提案是否真实存在及其待审批、已采纳、已拒绝数量。只有 exists=true 才能向作者宣称提交成功。",
        { proposalId: powerIdSchema },
        getPowerProposalStatusHandler,
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
        "novel_characters_validate_proposal",
        "校验人物库候选的结构、种族/灵魂/分组/关系/物品引用闭合、重复 id 与人物卡必要字段。提交角色提案前必须调用。",
        {
          operations: z
            .array(characterProposalOperationSchema)
            .min(1)
            .max(MAX_CHARACTER_OPERATIONS),
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
            .max(MAX_CHARACTER_OPERATIONS),
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
