export const TIMELINE_DIRECTORY = "timeline";
export const TIMELINE_INDEX_PATH = "timeline/index.json";
export const TIMELINE_STORAGE_VERSION = 1 as const;
export const TIMELINE_SCHEMA_VERSION = 1 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export type TimelineCollectionKey =
  | "calendars"
  | "periods"
  | "views"
  | "branches"
  | "events";

const COLLECTION_SEGMENTS: Readonly<Record<TimelineCollectionKey, string>> =
  Object.freeze({
    calendars: "calendars",
    periods: "periods",
    views: "views",
    branches: "branches",
    events: "events",
  });

export interface TimelineStorageRecord {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface TimelineStorageAggregate {
  readonly schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  readonly calendars: readonly TimelineStorageRecord[];
  readonly periods: readonly TimelineStorageRecord[];
  readonly views: readonly TimelineStorageRecord[];
  readonly storyStartEventId: string | null;
  readonly factsThroughEventId: string | null;
  readonly branches: readonly TimelineStorageRecord[];
  readonly events: readonly TimelineStorageRecord[];
}

export interface TimelineTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedTimelineFiles {
  readonly library: TimelineStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadTimelineText = (path: string) => Promise<string>;

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

function nullableIdValue(path: string, value: unknown): string | null {
  if (value === null) return null;
  return idValue(path, value);
}

export function timelineRecordPath(
  key: TimelineCollectionKey,
  id: string,
): string {
  return `${TIMELINE_DIRECTORY}/${COLLECTION_SEGMENTS[key]}/records/${idValue(`${key} id`, id)}.json`;
}

function createCollectionFiles(
  key: TimelineCollectionKey,
  records: readonly TimelineStorageRecord[],
): {
  readonly entries: readonly { readonly id: string; readonly path: string }[];
  readonly files: readonly TimelineTextFile[];
} {
  const ids = new Set<string>();
  const files: TimelineTextFile[] = [];
  const entries = records.map((record, position) => {
    const id = idValue(`${key}.${position}.id`, record.id);
    if (ids.has(id)) throw new Error(`${key} 包含重复 id：${id}`);
    ids.add(id);
    const path = timelineRecordPath(key, id);
    files.push({ path, content: json(record) });
    return { id, path };
  });
  return { entries, files };
}

/** 将完整时间线拆成轻量根索引与五类独立记录；根索引固定最后返回。 */
export function createTimelineFiles(
  library: TimelineStorageAggregate,
): readonly TimelineTextFile[] {
  if (library.schemaVersion !== TIMELINE_SCHEMA_VERSION) {
    throw new Error(`时间线 schemaVersion 必须是 ${TIMELINE_SCHEMA_VERSION}`);
  }
  const collections = Object.fromEntries(
    (Object.keys(COLLECTION_SEGMENTS) as TimelineCollectionKey[]).map((key) => [
      key,
      createCollectionFiles(key, library[key]),
    ]),
  ) as Record<TimelineCollectionKey, ReturnType<typeof createCollectionFiles>>;
  const files = (Object.keys(COLLECTION_SEGMENTS) as TimelineCollectionKey[])
    .flatMap((key) => collections[key].files)
    .sort((left, right) => left.path.localeCompare(right.path));
  files.push({
    path: TIMELINE_INDEX_PATH,
    content: json({
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      storageVersion: TIMELINE_STORAGE_VERSION,
      storyStartEventId: nullableIdValue(
        "storyStartEventId",
        library.storyStartEventId,
      ),
      factsThroughEventId: nullableIdValue(
        "factsThroughEventId",
        library.factsThroughEventId,
      ),
      calendars: collections.calendars.entries,
      periods: collections.periods.entries,
      views: collections.views.entries,
      branches: collections.branches.entries,
      events: collections.events.entries,
    }),
  });
  return files;
}

function indexEntries(
  index: Record<string, unknown>,
  key: TimelineCollectionKey,
): readonly Record<string, unknown>[] {
  const entries = index[key];
  if (!Array.isArray(entries)) {
    throw new Error(`${TIMELINE_INDEX_PATH}.${key} 必须是数组`);
  }
  return entries.map((entry, position) =>
    objectValue(`${TIMELINE_INDEX_PATH}.${key}.${position}`, entry),
  );
}

async function loadCollection(
  read: ReadTimelineText,
  index: Record<string, unknown>,
  key: TimelineCollectionKey,
): Promise<readonly TimelineStorageRecord[]> {
  const ids = new Set<string>();
  return Promise.all(
    indexEntries(index, key).map(async (entry, position) => {
      const owner = `${TIMELINE_INDEX_PATH}.${key}.${position}`;
      const id = idValue(`${owner}.id`, entry.id);
      if (ids.has(id)) throw new Error(`${key} 索引包含重复 id：${id}`);
      ids.add(id);
      const expectedPath = timelineRecordPath(key, id);
      if (entry.path !== expectedPath) {
        throw new Error(`${owner}.path 必须是 ${expectedPath}`);
      }
      const record = objectValue(
        expectedPath,
        parseJson(expectedPath, await read(expectedPath)),
      );
      if (idValue(`${expectedPath}.id`, record.id) !== id) {
        throw new Error(`${expectedPath}.id 与索引不一致`);
      }
      return record as TimelineStorageRecord;
    }),
  );
}

/** 从根索引递归读取五类记录并聚合完整时间线。 */
export async function loadTimelineFiles(
  readText: ReadTimelineText,
): Promise<LoadedTimelineFiles> {
  const files = new Map<string, string>();
  const read: ReadTimelineText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = objectValue(
    TIMELINE_INDEX_PATH,
    parseJson(TIMELINE_INDEX_PATH, await read(TIMELINE_INDEX_PATH)),
  );
  if (index.schemaVersion !== TIMELINE_SCHEMA_VERSION) {
    throw new Error(
      `${TIMELINE_INDEX_PATH}.schemaVersion 必须是 ${TIMELINE_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== TIMELINE_STORAGE_VERSION) {
    throw new Error(
      `${TIMELINE_INDEX_PATH}.storageVersion 必须是 ${TIMELINE_STORAGE_VERSION}；旧单文件时间线不兼容且不迁移`,
    );
  }
  const [calendars, periods, views, branches, events] = await Promise.all([
    loadCollection(read, index, "calendars"),
    loadCollection(read, index, "periods"),
    loadCollection(read, index, "views"),
    loadCollection(read, index, "branches"),
    loadCollection(read, index, "events"),
  ]);
  return {
    library: {
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      calendars,
      periods,
      views,
      storyStartEventId: nullableIdValue(
        `${TIMELINE_INDEX_PATH}.storyStartEventId`,
        index.storyStartEventId,
      ),
      factsThroughEventId: nullableIdValue(
        `${TIMELINE_INDEX_PATH}.factsThroughEventId`,
        index.factsThroughEventId,
      ),
      branches,
      events,
    },
    files,
  };
}

export function timelineFileMap(
  files: readonly TimelineTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

export function serializeTimelineFileSnapshot(
  files: ReadonlyMap<string, string>,
): string {
  return JSON.stringify(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}
