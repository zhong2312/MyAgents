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
  powerSystemIndexSchema,
  powerSystemInteractionsSchema,
  powerSystemMetaSchema,
  powerSystemRecordSchema,
  type PowerSystemIndex,
  type PowerSystemInteractions,
  type PowerSystemMeta,
  type PowerSystemRecord,
} from "../../shared/novel-power-system-schema";
import {
  bindNovelWorkbenchRuntime,
  getNovelWorkbenchContext,
  NOVEL_WORKBENCH_MCP_ID,
} from "../novel-workbench-context";

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
  /^world\/power-systems\/(?:meta\.json|index\.json|interactions\.json|records\/[a-z0-9-]+\.json|pages\/[a-z0-9-]+\.md)$/;
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
  const interactionsPath = `${POWER_SYSTEM_ROOT}/interactions.json`;
  const [metaContent, indexContent, interactionsContent] = await Promise.all([
    candidateContent(metaPath),
    candidateContent(indexPath),
    candidateContent(interactionsPath),
  ]);
  if (metaContent === null) errors.push("力量体系库缺少 meta.json");
  if (indexContent === null) errors.push("力量体系库缺少 index.json");
  if (interactionsContent === null)
    errors.push("力量体系库缺少 interactions.json");
  if (
    metaContent === null ||
    indexContent === null ||
    interactionsContent === null
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
  const interactions = parsePowerSystemSchema<PowerSystemInteractions>(
    interactionsPath,
    interactionsContent,
    powerSystemInteractionsSchema,
    errors,
  );
  if (!meta || !index || !interactions) return errors;

  const typeIds = new Set<string>();
  for (const type of meta.systemTypes) {
    if (typeIds.has(type.id)) errors.push(`力量体系类型 id 重复：${type.id}`);
    typeIds.add(type.id);
  }

  const systemIds = new Set<string>();
  const records = new Map<string, PowerSystemRecord>();
  const graphTargets = new Map<string, Set<string>>();
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
    records.set(record.id, record);
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
    const targetsForSystem = new Set<string>([record.id]);
    record.elements.forEach((item) => targetsForSystem.add(item.id));
    record.tracks.forEach((track) => {
      targetsForSystem.add(track.id);
      track.states.forEach((state) => targetsForSystem.add(state.id));
    });
    record.rules.forEach((item) => targetsForSystem.add(item.id));
    record.dimensions.forEach((item) => targetsForSystem.add(item.id));
    graphTargets.set(record.id, targetsForSystem);
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

  for (const interaction of interactions.interactions) {
    for (const reference of [interaction.left, interaction.right]) {
      if (!systemIds.has(reference.systemId)) {
        errors.push(
          `跨体系交互“${interaction.name}”引用了不存在的体系：${reference.systemId}`,
        );
        continue;
      }
      if (!graphTargets.get(reference.systemId)?.has(reference.targetId)) {
        errors.push(
          `跨体系交互“${interaction.name}”引用了不存在的目标：${reference.targetId}`,
        );
      }
      if (
        reference.kind === "system" &&
        reference.targetId !== reference.systemId
      ) {
        errors.push(`跨体系交互“${interaction.name}”的体系级引用不一致`);
      }
    }
  }
  return errors;
}

async function getPowerSystemContextHandler(args: {
  systemId?: string;
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const files: Record<string, string | null> = {};
    const corePaths = [
      `${POWER_SYSTEM_ROOT}/meta.json`,
      `${POWER_SYSTEM_ROOT}/index.json`,
      `${POWER_SYSTEM_ROOT}/interactions.json`,
    ];
    for (const path of corePaths) {
      files[path] = await readOptional(workspaceFile(workspace, path));
    }
    if (args.systemId) {
      if (!ID_PATTERN.test(args.systemId)) {
        throw new Error("systemId 只能使用小写字母、数字和连字符");
      }
      const recordPath = `${POWER_SYSTEM_ROOT}/records/${args.systemId}.json`;
      const pagePath = `${POWER_SYSTEM_ROOT}/pages/${args.systemId}.md`;
      files[recordPath] = await readOptional(
        workspaceFile(workspace, recordPath),
      );
      files[pagePath] = await readOptional(workspaceFile(workspace, pagePath));
    }
    return result({ mode: context.mode, files });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validatePowerSystemHandler(args: {
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  try {
    const errors = await validatePowerSystemChanges(args.changes);
    return result({ valid: errors.length === 0, errors }, errors.length > 0);
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitPowerSystemHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    const { workspace, context } = requireWorkspace();
    const errors = await validatePowerSystemChanges(args.changes);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const proposalId =
      args.proposalId?.trim() || `proposal-${randomUUID().slice(0, 8)}`;
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
    return result({
      submitted: true,
      proposalId,
      changeCount: manifestChanges.length,
      reviewAction: "请作者在小说工作台的力量体系页面点击“审阅提案”。",
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
  return createSdkMcpServer({
    name: NOVEL_WORKBENCH_MCP_ID,
    version: "1.0.0",
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
        "读取力量体系库的类型、索引和跨体系交互；传 systemId 时同时返回该体系的结构化记录与说明页。",
        { systemId: z.string().regex(ID_PATTERN).optional() },
        getPowerSystemContextHandler,
      ),
      tool(
        "novel_power_validate_changes",
        "校验力量体系变更的文件范围、Schema、索引闭合、体系类型、关系、状态、标尺和跨体系引用。提交提案前必须调用。",
        {
          changes: z.array(changeSchema).min(1).max(MAX_POWER_SYSTEM_CHANGES),
        },
        validatePowerSystemHandler,
      ),
      tool(
        "novel_power_submit_proposal",
        "提交待审批的力量体系提案。该工具只写 proposals 快照，不会修改正式力量体系。",
        {
          proposalId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          changes: z.array(changeSchema).min(1).max(MAX_POWER_SYSTEM_CHANGES),
        },
        submitPowerSystemHandler,
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
