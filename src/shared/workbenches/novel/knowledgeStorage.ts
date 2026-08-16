export const KNOWLEDGE_DIRECTORY = "knowledge";
export const KNOWLEDGE_STORAGE_VERSION = 1 as const;
export const KNOWLEDGE_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_COLLECTIONS = [
  "entities",
  "relations",
  "facts",
] as const;

export type KnowledgeCollection = (typeof KNOWLEDGE_COLLECTIONS)[number];

export const KNOWLEDGE_LEGACY_PATHS = Object.freeze(
  KNOWLEDGE_COLLECTIONS.map((collection) => `knowledge/${collection}.json`),
);

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface KnowledgeStorageRecord {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface KnowledgeStorageAggregate {
  readonly schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  readonly entities: readonly KnowledgeStorageRecord[];
  readonly relations: readonly KnowledgeStorageRecord[];
  readonly facts: readonly KnowledgeStorageRecord[];
}

export interface KnowledgeTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedKnowledgeFiles {
  readonly library: KnowledgeStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadKnowledgeText = (path: string) => Promise<string>;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw new Error(
      `${path} 不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function objectValue(path: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function idValue(path: string, value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${path} 只能使用小写字母、数字和连字符`);
  }
  return value;
}

export function knowledgeCollectionDirectory(
  collection: KnowledgeCollection,
): string {
  return `${KNOWLEDGE_DIRECTORY}/${collection}`;
}

export function knowledgeIndexPath(collection: KnowledgeCollection): string {
  return `${knowledgeCollectionDirectory(collection)}/index.json`;
}

export function knowledgeRecordsDirectory(
  collection: KnowledgeCollection,
): string {
  return `${knowledgeCollectionDirectory(collection)}/records`;
}

export function knowledgeRecordPath(
  collection: KnowledgeCollection,
  id: string,
): string {
  return `${knowledgeRecordsDirectory(collection)}/${idValue(`${collection} record id`, id)}.json`;
}

function createCollectionFiles(
  collection: KnowledgeCollection,
  records: readonly KnowledgeStorageRecord[],
): readonly KnowledgeTextFile[] {
  const ids = new Set<string>();
  const references: { readonly id: string; readonly path: string }[] = [];
  const files = records.map((record, position) => {
    const id = idValue(`${collection}.${position}.id`, record.id);
    if (ids.has(id)) throw new Error(`${collection} 包含重复 id：${id}`);
    ids.add(id);
    const path = knowledgeRecordPath(collection, id);
    references.push({ id, path });
    return { path, content: json(record) };
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  files.push({
    path: knowledgeIndexPath(collection),
    content: json({
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      storageVersion: KNOWLEDGE_STORAGE_VERSION,
      [collection]: references,
    }),
  });
  return files;
}

/** 将知识实体、关系和事实分别拆成轻量索引与独立记录。 */
export function createKnowledgeFiles(
  library: KnowledgeStorageAggregate,
): readonly KnowledgeTextFile[] {
  if (library.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
    throw new Error(`知识库 schemaVersion 必须是 ${KNOWLEDGE_SCHEMA_VERSION}`);
  }
  return KNOWLEDGE_COLLECTIONS.flatMap((collection) =>
    createCollectionFiles(collection, library[collection]),
  );
}

async function loadCollection(
  read: ReadKnowledgeText,
  collection: KnowledgeCollection,
): Promise<readonly KnowledgeStorageRecord[]> {
  const indexPath = knowledgeIndexPath(collection);
  const index = objectValue(
    indexPath,
    parseJson(indexPath, await read(indexPath)),
  );
  if (index.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
    throw new Error(
      `${indexPath}.schemaVersion 必须是 ${KNOWLEDGE_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== KNOWLEDGE_STORAGE_VERSION) {
    throw new Error(
      `${indexPath}.storageVersion 必须是 ${KNOWLEDGE_STORAGE_VERSION}；旧单文件知识库不兼容且不迁移`,
    );
  }
  const references = index[collection];
  if (!Array.isArray(references)) {
    throw new Error(`${indexPath}.${collection} 必须是数组`);
  }
  const ids = new Set<string>();
  return Promise.all(
    references.map(async (value, position) => {
      const owner = `${indexPath}.${collection}.${position}`;
      const reference = objectValue(owner, value);
      const id = idValue(`${owner}.id`, reference.id);
      if (ids.has(id)) throw new Error(`${collection} 索引包含重复 id：${id}`);
      ids.add(id);
      const expectedPath = knowledgeRecordPath(collection, id);
      if (reference.path !== expectedPath) {
        throw new Error(`${owner}.path 必须是 ${expectedPath}`);
      }
      const record = objectValue(
        expectedPath,
        parseJson(expectedPath, await read(expectedPath)),
      );
      if (idValue(`${expectedPath}.id`, record.id) !== id) {
        throw new Error(`${expectedPath}.id 与索引不一致`);
      }
      return record as KnowledgeStorageRecord;
    }),
  );
}

/** 按三个根索引递归聚合正式知识记录；未被索引引用的孤立文件不会进入结果。 */
export async function loadKnowledgeFiles(
  readText: ReadKnowledgeText,
): Promise<LoadedKnowledgeFiles> {
  const files = new Map<string, string>();
  const read: ReadKnowledgeText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const [entities, relations, facts] = await Promise.all(
    KNOWLEDGE_COLLECTIONS.map((collection) => loadCollection(read, collection)),
  );
  return {
    library: {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      entities,
      relations,
      facts,
    },
    files,
  };
}

export function knowledgeFileMap(
  files: readonly KnowledgeTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

export function serializeKnowledgeFileSnapshot(
  files: ReadonlyMap<string, string> | readonly KnowledgeTextFile[],
): string {
  const entries = Array.isArray(files)
    ? files.map((file) => [file.path, file.content] as const)
    : [...files.entries()];
  return JSON.stringify(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}
