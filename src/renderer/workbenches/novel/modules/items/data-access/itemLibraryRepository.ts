import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createDefaultItemLibraryMeta,
  createEmptyItemLibraryIndex,
  ITEM_LIBRARY_SCHEMA_VERSION,
  UNCATEGORIZED_ITEM_CATEGORY_ID,
} from "../business/itemLibraryDefaults";
import {
  getEffectiveCategoryFields,
  parseItemLibraryIndex,
  parseItemLibraryMeta,
  parseItemRecord,
  serializeItemLibraryFile,
  type CategoryFieldDefinition,
  type ItemIndexEntry,
  type ItemFieldDefinition,
  type ItemFieldValue,
  type ItemLibraryIndex,
  type ItemLibraryMeta,
  type ItemRecord,
} from "../entities/itemLibrarySchema";

export const ITEM_LIBRARY_PATHS = Object.freeze({
  meta: "world/items/meta.json",
  index: "world/items/index.json",
  records: "world/items/records",
  pages: "world/items/pages",
});

export interface LoadedItemLibrary {
  readonly meta: ItemLibraryMeta;
  readonly metaContent: string;
  readonly index: ItemLibraryIndex;
  readonly indexContent: string;
}

export interface LoadedItem {
  readonly record: ItemRecord;
  readonly recordContent: string;
  readonly pageContent: string;
}

export interface SaveItemResult {
  readonly library: LoadedItemLibrary;
  readonly item: LoadedItem;
}

export interface CreateItemInput {
  readonly id: string;
  readonly name: string;
  readonly categoryId?: string;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly values?: Readonly<Record<string, ItemRecord["values"][string]>>;
  readonly pageContent?: string;
}

export interface CreateItemsResult {
  readonly library: LoadedItemLibrary;
  readonly items: readonly LoadedItem[];
}

export interface NovelItemLibraryRepository {
  load(): Promise<LoadedItemLibrary>;
  loadItem(entry: ItemIndexEntry): Promise<LoadedItem>;
  saveMeta(
    library: LoadedItemLibrary,
    meta: ItemLibraryMeta,
  ): Promise<LoadedItemLibrary>;
  createItem(
    library: LoadedItemLibrary,
    input: CreateItemInput,
  ): Promise<SaveItemResult>;
  createItems(
    library: LoadedItemLibrary,
    inputs: readonly CreateItemInput[],
  ): Promise<CreateItemsResult>;
  saveItem(
    library: LoadedItemLibrary,
    item: LoadedItem,
    record: ItemRecord,
    pageContent: string,
  ): Promise<SaveItemResult>;
  deleteItem(
    library: LoadedItemLibrary,
    itemId: string,
  ): Promise<LoadedItemLibrary>;
}

function serializeMeta(meta: ItemLibraryMeta) {
  return serializeItemLibraryFile(meta);
}

function serializeIndex(index: ItemLibraryIndex) {
  return serializeItemLibraryFile(index);
}

function serializeRecord(record: ItemRecord) {
  return serializeItemLibraryFile(record);
}

function itemPaths(id: string) {
  return {
    recordPath: `${ITEM_LIBRARY_PATHS.records}/${id}.json`,
    pagePath: `${ITEM_LIBRARY_PATHS.pages}/${id}.md`,
  } as const;
}

function cloneFieldValue(value: ItemRecord["values"][string]) {
  return Array.isArray(value) ? [...value] : value;
}

function buildNewItem(
  library: LoadedItemLibrary,
  input: CreateItemInput,
): LoadedItem {
  const name = input.name.trim();
  if (!name) throw new Error("物品名称不能为空");
  if (library.index.items.some((item) => item.id === input.id)) {
    throw new Error(`物品 id 已存在：${input.id}`);
  }
  const categoryId = input.categoryId ?? UNCATEGORIZED_ITEM_CATEGORY_ID;
  const category = library.meta.categories.find((item) => item.id === categoryId);
  if (!category) {
    throw new Error(`物品分类不存在：${categoryId}`);
  }
  if (category.archived) {
    throw new Error(`不能向已归档分类创建物品：${category.name}`);
  }
  const now = new Date().toISOString();
  const values = Object.fromEntries(
    getEffectiveCategoryFields(library.meta, categoryId).map((field) => [
      field.id,
      cloneFieldValue(field.defaultValue),
    ]),
  );
  for (const [fieldId, value] of Object.entries(input.values ?? {})) {
    values[fieldId] = cloneFieldValue(value);
  }
  const record: ItemRecord = {
    schemaVersion: ITEM_LIBRARY_SCHEMA_VERSION,
    id: input.id,
    name,
    aliases: (input.aliases ?? []).map((value) => value.trim()).filter(Boolean),
    categoryId,
    status: "draft",
    tags: (input.tags ?? []).map((value) => value.trim()).filter(Boolean),
    summary: input.summary?.trim() ?? "",
    coverPath: null,
    values,
    itemFields: [],
    createdAt: now,
    updatedAt: now,
  };
  const paths = itemPaths(record.id);
  const recordContent = serializeRecord(record);
  const parsedRecord = parseItemRecord(paths.recordPath, recordContent);
  validateRecordReferences(library, parsedRecord);
  validateRecordFieldValues(library, parsedRecord);
  const pageContent = input.pageContent?.trim()
    ? `${input.pageContent.trimEnd()}\n`
    : `# ${name}\n\n`;
  return Object.freeze({ record: parsedRecord, recordContent, pageContent });
}

function toIndexEntry(record: ItemRecord): ItemIndexEntry {
  return {
    id: record.id,
    name: record.name,
    categoryId: record.categoryId,
    status: record.status,
    tags: [...record.tags],
    summary: record.summary,
    ...itemPaths(record.id),
    updatedAt: record.updatedAt,
  };
}

function replaceLibrary(
  library: LoadedItemLibrary,
  patch: Partial<LoadedItemLibrary>,
): LoadedItemLibrary {
  return Object.freeze({ ...library, ...patch });
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, content, { createParents: true });
  } catch {
    return storage.readText(path);
  }
}

export function createItemLibraryInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: ITEM_LIBRARY_PATHS.meta,
      content: serializeMeta(createDefaultItemLibraryMeta()),
    },
    {
      path: ITEM_LIBRARY_PATHS.index,
      content: serializeIndex(createEmptyItemLibraryIndex()),
    },
  ];
}

function validateReferences(library: LoadedItemLibrary): void {
  const categoryIds = new Set(
    library.meta.categories.map((category) => category.id),
  );
  for (const item of library.index.items) {
    if (!categoryIds.has(item.categoryId)) {
      throw new Error(
        `物品“${item.name}”关联了不存在的分类：${item.categoryId}`,
      );
    }
  }
}

function validateStableFieldDefinitions(
  previous: readonly { readonly id: string; readonly label: string; readonly type: string }[],
  next: readonly { readonly id: string; readonly label: string; readonly type: string }[],
  scope: string,
): void {
  const nextById = new Map(next.map((field) => [field.id, field]));
  for (const field of previous) {
    const nextField = nextById.get(field.id);
    if (!nextField) {
      throw new Error(`${scope}字段“${field.label}”只能归档，不能直接删除`);
    }
    if (nextField.type !== field.type) {
      throw new Error(`${scope}字段“${field.label}”已有稳定类型，不能原地修改`);
    }
  }
}

function validateRecordReferences(
  library: LoadedItemLibrary,
  record: ItemRecord,
): void {
  const category = library.meta.categories.find(
    (candidate) => candidate.id === record.categoryId,
  );
  if (!category) {
    throw new Error(`物品“${record.name}”关联了不存在的分类：${record.categoryId}`);
  }
  const categoryFieldIds = new Set(library.meta.fields.map((field) => field.id));
  const collision = record.itemFields.find((field) =>
    categoryFieldIds.has(field.id),
  );
  if (collision) {
    throw new Error(`物品字段 id 与分类字段冲突：${collision.id}`);
  }
}

type EffectiveItemField = CategoryFieldDefinition | ItemFieldDefinition;

function fieldValueIsPresent(value: ItemFieldValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "boolean" || Number.isFinite(value);
}

function validateFieldValue(
  field: EffectiveItemField,
  value: ItemFieldValue | undefined,
): void {
  if (value === undefined || value === null) {
    if (field.required) {
      throw new Error(`必填字段“${field.label}”不能为空`);
    }
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`字段“${field.label}”必须是有效数字`);
    }
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`字段“${field.label}”必须是开关值`);
    }
  } else if (field.type === "multi-select") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`字段“${field.label}”必须是多选数组`);
    }
    const invalid = value.find(
      (item) => field.options.length > 0 && !field.options.includes(item),
    );
    if (invalid) {
      throw new Error(`字段“${field.label}”包含非法选项：${invalid}`);
    }
  } else if (typeof value !== "string") {
    throw new Error(`字段“${field.label}”必须是文本值`);
  } else if (
    field.type === "single-select" &&
    value !== "" &&
    field.options.length > 0 &&
    !field.options.includes(value)
  ) {
    throw new Error(`字段“${field.label}”包含非法选项：${value}`);
  }
  if (field.required && !fieldValueIsPresent(value)) {
    throw new Error(`必填字段“${field.label}”不能为空`);
  }
}

function validateRecordFieldValues(
  library: LoadedItemLibrary,
  record: ItemRecord,
): void {
  const fields: EffectiveItemField[] = [
    ...getEffectiveCategoryFields(library.meta, record.categoryId),
    ...record.itemFields.filter((field) => !field.archived),
  ];
  for (const field of fields) {
    validateFieldValue(field, record.values[field.id] ?? field.defaultValue);
  }
}

async function restoreText(
  storage: WorkbenchStorage,
  path: string,
  content: string,
  expectedContent: string,
) {
  await storage.writeText(path, content, { expectedContent }).catch(() => null);
}

export function createNovelItemLibraryRepository(
  storage: WorkbenchStorage,
): NovelItemLibraryRepository {
  const repository: NovelItemLibraryRepository = {
    async load() {
      if (!storage.isAvailable) {
        throw new Error("小说物品库存储仅在 MyNovelStudio 桌面端可用");
      }
      const initialFiles = createItemLibraryInitializationFiles();
      const [metaFile, indexFile] = await Promise.all(
        initialFiles.map((file) =>
          ensureTextFile(storage, file.path, file.content),
        ),
      );
      const library: LoadedItemLibrary = Object.freeze({
        meta: parseItemLibraryMeta(metaFile.content),
        metaContent: metaFile.content,
        index: parseItemLibraryIndex(indexFile.content),
        indexContent: indexFile.content,
      });
      validateReferences(library);
      return library;
    },

    async loadItem(entry) {
      const [recordFile, pageFile] = await Promise.all([
        storage.readText(entry.recordPath),
        storage.readText(entry.pagePath),
      ]);
      const record = parseItemRecord(entry.recordPath, recordFile.content);
      if (record.id !== entry.id) {
        throw new Error(`物品索引与记录 id 不一致：${entry.id}`);
      }
      return Object.freeze({
        record,
        recordContent: recordFile.content,
        pageContent: pageFile.content,
      });
    },

    async saveMeta(library, meta) {
      const content = serializeMeta(meta);
      const parsedMeta = parseItemLibraryMeta(content);
      validateStableFieldDefinitions(library.meta.fields, parsedMeta.fields, "分类");
      const candidate = replaceLibrary(library, { meta: parsedMeta });
      validateReferences(candidate);
      const file = await storage.writeText(ITEM_LIBRARY_PATHS.meta, content, {
        expectedContent: library.metaContent,
      });
      const next = replaceLibrary(library, {
        meta: parsedMeta,
        metaContent: file.content,
      });
      return next;
    },

    async createItem(library, input) {
      const result = await repository.createItems(library, [input]);
      const item = result.items[0];
      if (!item) throw new Error("物品创建结果为空");
      return { library: result.library, item };
    },

    async createItems(library, inputs) {
      if (inputs.length === 0) throw new Error("至少需要创建一件物品");
      const inputIds = new Set<string>();
      for (const input of inputs) {
        if (inputIds.has(input.id)) throw new Error(`物品 id 重复：${input.id}`);
        inputIds.add(input.id);
      }
      const items = inputs.map((input) => buildNewItem(library, input));
      const createdPaths: string[] = [];
      const rollbackCreatedFiles = async () => {
        await Promise.all(
          createdPaths.map((path) =>
            storage.remove(path, { permanent: true }).catch(() => false),
          ),
        );
      };
      try {
        for (const item of items) {
          const paths = itemPaths(item.record.id);
          await storage.createText(paths.recordPath, item.recordContent, {
            createParents: true,
          });
          createdPaths.push(paths.recordPath);
          await storage.createText(paths.pagePath, item.pageContent, {
            createParents: true,
          });
          createdPaths.push(paths.pagePath);
        }
        const nextIndex: ItemLibraryIndex = {
          ...library.index,
          items: [
            ...library.index.items,
            ...items.map((item) => toIndexEntry(item.record)),
          ],
        };
        const indexContent = serializeIndex(nextIndex);
        const indexFile = await storage.writeText(
          ITEM_LIBRARY_PATHS.index,
          indexContent,
          { expectedContent: library.indexContent },
        );
        return {
          library: replaceLibrary(library, {
            index: parseItemLibraryIndex(indexFile.content),
            indexContent: indexFile.content,
          }),
          items,
        };
      } catch (error) {
        await rollbackCreatedFiles();
        throw error;
      }
    },

    async deleteItem(library, itemId) {
      if (!library.index.items.some((entry) => entry.id === itemId)) {
        throw new Error(`物品不存在：${itemId}`);
      }
      // 先移除索引（CAS 保护），成功后再删文件；索引失败时文件未动，安全无残留。
      const nextIndex: ItemLibraryIndex = {
        ...library.index,
        items: library.index.items.filter((entry) => entry.id !== itemId),
      };
      const indexFile = await storage.writeText(
        ITEM_LIBRARY_PATHS.index,
        serializeIndex(nextIndex),
        { expectedContent: library.indexContent },
      );
      const paths = itemPaths(itemId);
      await storage
        .remove(paths.recordPath, { permanent: true })
        .catch(() => false);
      await storage
        .remove(paths.pagePath, { permanent: true })
        .catch(() => false);
      return replaceLibrary(library, {
        index: parseItemLibraryIndex(indexFile.content),
        indexContent: indexFile.content,
      });
    },

    async saveItem(library, item, record, pageContent) {
      if (record.id !== item.record.id) {
        throw new Error("保存物品时不得修改稳定 id");
      }
      const normalizedRecord: ItemRecord = {
        ...record,
        name: record.name.trim(),
        aliases: record.aliases.map((alias) => alias.trim()).filter(Boolean),
        tags: record.tags.map((tag) => tag.trim()).filter(Boolean),
        summary: record.summary.trim(),
        updatedAt: new Date().toISOString(),
      };
      const paths = itemPaths(record.id);
      const recordContent = serializeRecord(normalizedRecord);
      const parsedRecord = parseItemRecord(paths.recordPath, recordContent);
      validateStableFieldDefinitions(
        item.record.itemFields,
        parsedRecord.itemFields,
        "物品",
      );
      validateRecordReferences(library, parsedRecord);
      validateRecordFieldValues(library, parsedRecord);
      const writtenRecord = await storage.writeText(
        paths.recordPath,
        recordContent,
        { expectedContent: item.recordContent },
      );
      let writtenPage: WorkbenchTextFile | null = null;
      try {
        writtenPage = await storage.writeText(paths.pagePath, pageContent, {
          expectedContent: item.pageContent,
        });
        const nextIndex: ItemLibraryIndex = {
          ...library.index,
          items: library.index.items.map((entry) =>
            entry.id === parsedRecord.id ? toIndexEntry(parsedRecord) : entry,
          ),
        };
        const indexFile = await storage.writeText(
          ITEM_LIBRARY_PATHS.index,
          serializeIndex(nextIndex),
          { expectedContent: library.indexContent },
        );
        const nextLibrary = replaceLibrary(library, {
          index: parseItemLibraryIndex(indexFile.content),
          indexContent: indexFile.content,
        });
        validateReferences(nextLibrary);
        return {
          library: nextLibrary,
          item: Object.freeze({
            record: parsedRecord,
            recordContent: writtenRecord.content,
            pageContent: writtenPage.content,
          }),
        };
      } catch (error) {
        await restoreText(
          storage,
          paths.recordPath,
          item.recordContent,
          writtenRecord.content,
        );
        if (writtenPage) {
          await restoreText(
            storage,
            paths.pagePath,
            item.pageContent,
            writtenPage.content,
          );
        }
        throw error;
      }
    },
  };
  return Object.freeze(repository);
}
