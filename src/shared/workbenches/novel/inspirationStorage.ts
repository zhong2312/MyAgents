export const INSPIRATION_DIRECTORY = "inspiration";
export const INSPIRATION_INDEX_PATH = "inspiration/index.json";
export const INSPIRATION_RECORDS_DIRECTORY = "inspiration/records";
export const INSPIRATION_STORAGE_VERSION = 1 as const;
export const INSPIRATION_SCHEMA_VERSION = 1 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface InspirationStorageRecord {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface InspirationStorageAggregate {
  readonly schemaVersion: typeof INSPIRATION_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly items: readonly InspirationStorageRecord[];
}

export interface InspirationTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedInspirationFiles {
  readonly library: InspirationStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadInspirationText = (path: string) => Promise<string>;

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

function updatedAtValue(path: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} 必须是非空字符串`);
  }
  return value;
}

export function inspirationRecordPath(id: string): string {
  return `${INSPIRATION_RECORDS_DIRECTORY}/${idValue("inspiration id", id)}.json`;
}

function createRecordFiles(records: readonly InspirationStorageRecord[]): {
  readonly entries: readonly { readonly id: string; readonly path: string }[];
  readonly files: readonly InspirationTextFile[];
} {
  const ids = new Set<string>();
  const files: InspirationTextFile[] = [];
  const entries = records.map((record, position) => {
    const id = idValue(`items.${position}.id`, record.id);
    if (ids.has(id)) throw new Error(`items 包含重复 id：${id}`);
    ids.add(id);
    const path = inspirationRecordPath(id);
    files.push({ path, content: json(record) });
    return { id, path };
  });
  return { entries, files };
}

/** 将完整灵感库拆成轻量根索引与独立灵感记录；根索引固定最后返回。 */
export function createInspirationFiles(
  library: InspirationStorageAggregate,
): readonly InspirationTextFile[] {
  if (library.schemaVersion !== INSPIRATION_SCHEMA_VERSION) {
    throw new Error(`灵感 schemaVersion 必须是 ${INSPIRATION_SCHEMA_VERSION}`);
  }
  const updatedAt = updatedAtValue("inspiration.updatedAt", library.updatedAt);
  const collection = createRecordFiles(library.items);
  const files = [...collection.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  files.push({
    path: INSPIRATION_INDEX_PATH,
    content: json({
      schemaVersion: INSPIRATION_SCHEMA_VERSION,
      storageVersion: INSPIRATION_STORAGE_VERSION,
      updatedAt,
      items: collection.entries,
    }),
  });
  return files;
}

async function loadRecords(
  read: ReadInspirationText,
  index: Record<string, unknown>,
): Promise<readonly InspirationStorageRecord[]> {
  const entries = index.items;
  if (!Array.isArray(entries)) {
    throw new Error(`${INSPIRATION_INDEX_PATH}.items 必须是数组`);
  }
  const ids = new Set<string>();
  return Promise.all(
    entries.map(async (entry, position) => {
      const owner = `${INSPIRATION_INDEX_PATH}.items.${position}`;
      const reference = objectValue(owner, entry);
      const id = idValue(`${owner}.id`, reference.id);
      if (ids.has(id)) throw new Error(`items 索引包含重复 id：${id}`);
      ids.add(id);
      const expectedPath = inspirationRecordPath(id);
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
      return record as InspirationStorageRecord;
    }),
  );
}

/** 从根索引递归读取全部灵感记录并聚合完整灵感库。 */
export async function loadInspirationFiles(
  readText: ReadInspirationText,
): Promise<LoadedInspirationFiles> {
  const files = new Map<string, string>();
  const read: ReadInspirationText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = objectValue(
    INSPIRATION_INDEX_PATH,
    parseJson(INSPIRATION_INDEX_PATH, await read(INSPIRATION_INDEX_PATH)),
  );
  if (index.schemaVersion !== INSPIRATION_SCHEMA_VERSION) {
    throw new Error(
      `${INSPIRATION_INDEX_PATH}.schemaVersion 必须是 ${INSPIRATION_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== INSPIRATION_STORAGE_VERSION) {
    throw new Error(
      `${INSPIRATION_INDEX_PATH}.storageVersion 必须是 ${INSPIRATION_STORAGE_VERSION}；旧单文件灵感库不兼容且不迁移`,
    );
  }
  const updatedAt = updatedAtValue(
    `${INSPIRATION_INDEX_PATH}.updatedAt`,
    index.updatedAt,
  );
  return {
    library: {
      schemaVersion: INSPIRATION_SCHEMA_VERSION,
      updatedAt,
      items: await loadRecords(read, index),
    },
    files,
  };
}

export function inspirationFileMap(
  files: readonly InspirationTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

/** 精确表示一次多文件读取快照，供并发保存和 AI sourceHash 使用。 */
export function serializeInspirationFileSnapshot(
  files: ReadonlyMap<string, string> | readonly InspirationTextFile[],
): string {
  const entries = Array.isArray(files)
    ? files.map((file) => [file.path, file.content] as const)
    : [...files.entries()];
  return JSON.stringify(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}
