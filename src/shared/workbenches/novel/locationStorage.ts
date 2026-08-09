export const LOCATION_DIRECTORY = "world/locations";
export const LOCATION_INDEX_PATH = "world/locations/index.json";
export const LOCATION_STORAGE_VERSION = 1 as const;
export const LOCATION_SCHEMA_VERSION = 1 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface LocationStorageRecord {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface LocationStorageAggregate {
  readonly schemaVersion: typeof LOCATION_SCHEMA_VERSION;
  readonly locations: readonly LocationStorageRecord[];
}

export interface LocationTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedLocationFiles {
  readonly library: LocationStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadLocationText = (path: string) => Promise<string>;

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

export function locationRecordPath(id: string): string {
  const validId = idValue("location id", id);
  return `${LOCATION_DIRECTORY}/records/${validId}.json`;
}

function createRecordFiles(records: readonly LocationStorageRecord[]): {
  readonly entries: readonly { readonly id: string; readonly path: string }[];
  readonly files: readonly LocationTextFile[];
} {
  const ids = new Set<string>();
  const files: LocationTextFile[] = [];
  const entries = records.map((record, position) => {
    const id = idValue(`locations.${position}.id`, record.id);
    if (ids.has(id)) throw new Error(`locations 包含重复 id：${id}`);
    ids.add(id);
    const path = locationRecordPath(id);
    files.push({ path, content: json(record) });
    return { id, path };
  });
  return { entries, files };
}

/** 将完整地点库拆成轻量根索引与独立地点记录；根索引固定最后返回。 */
export function createLocationFiles(
  library: LocationStorageAggregate,
): readonly LocationTextFile[] {
  if (library.schemaVersion !== LOCATION_SCHEMA_VERSION) {
    throw new Error(`地点 schemaVersion 必须是 ${LOCATION_SCHEMA_VERSION}`);
  }
  const collection = createRecordFiles(library.locations);
  const files = [...collection.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  files.push({
    path: LOCATION_INDEX_PATH,
    content: json({
      schemaVersion: LOCATION_SCHEMA_VERSION,
      storageVersion: LOCATION_STORAGE_VERSION,
      locations: collection.entries,
    }),
  });
  return files;
}

async function loadRecords(
  read: ReadLocationText,
  index: Record<string, unknown>,
): Promise<readonly LocationStorageRecord[]> {
  const entries = index.locations;
  if (!Array.isArray(entries)) {
    throw new Error(`${LOCATION_INDEX_PATH}.locations 必须是数组`);
  }
  const ids = new Set<string>();
  return Promise.all(
    entries.map(async (entry, position) => {
      const owner = `${LOCATION_INDEX_PATH}.locations.${position}`;
      const reference = objectValue(owner, entry);
      const id = idValue(`${owner}.id`, reference.id);
      if (ids.has(id)) throw new Error(`locations 索引包含重复 id：${id}`);
      ids.add(id);
      const expectedPath = locationRecordPath(id);
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
      return record as LocationStorageRecord;
    }),
  );
}

/** 从根索引递归读取全部地点记录并聚合完整地点库。 */
export async function loadLocationFiles(
  readText: ReadLocationText,
): Promise<LoadedLocationFiles> {
  const files = new Map<string, string>();
  const read: ReadLocationText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = objectValue(
    LOCATION_INDEX_PATH,
    parseJson(LOCATION_INDEX_PATH, await read(LOCATION_INDEX_PATH)),
  );
  if (index.schemaVersion !== LOCATION_SCHEMA_VERSION) {
    throw new Error(
      `${LOCATION_INDEX_PATH}.schemaVersion 必须是 ${LOCATION_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== LOCATION_STORAGE_VERSION) {
    throw new Error(
      `${LOCATION_INDEX_PATH}.storageVersion 必须是 ${LOCATION_STORAGE_VERSION}；旧单文件地点库不兼容且不迁移`,
    );
  }
  return {
    library: {
      schemaVersion: LOCATION_SCHEMA_VERSION,
      locations: await loadRecords(read, index),
    },
    files,
  };
}

export function locationFileMap(
  files: readonly LocationTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

export function serializeLocationFileSnapshot(
  files: ReadonlyMap<string, string>,
): string {
  return JSON.stringify(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}
