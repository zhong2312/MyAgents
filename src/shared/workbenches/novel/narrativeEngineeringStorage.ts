export const NARRATIVE_ENGINEERING_DIRECTORY = "narrative";
export const NARRATIVE_ENGINEERING_INDEX_PATH = "narrative/index.json";
export const NARRATIVE_ENGINEERING_STORAGE_VERSION = 1 as const;
export const NARRATIVE_ENGINEERING_SCHEMA_VERSION = 4 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export type NarrativeCollectionKey =
  | "lines"
  | "arcs"
  | "directories"
  | "chapters"
  | "simulationProposals";

const COLLECTION_SEGMENTS: Readonly<Record<NarrativeCollectionKey, string>> =
  Object.freeze({
    lines: "lines",
    arcs: "arcs",
    directories: "directories",
    chapters: "chapters",
    simulationProposals: "simulation-proposals",
  });

export interface NarrativeStorageRecord {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface NarrativeEngineeringStorageAggregate {
  readonly schemaVersion: typeof NARRATIVE_ENGINEERING_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly lines: readonly NarrativeStorageRecord[];
  readonly arcs: readonly NarrativeStorageRecord[];
  readonly directories: readonly NarrativeStorageRecord[];
  readonly chapters: readonly NarrativeStorageRecord[];
  readonly simulationProposals?: readonly NarrativeStorageRecord[];
  readonly legacyArchive?: unknown;
}

export interface NarrativeEngineeringTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedNarrativeEngineeringFiles {
  readonly library: NarrativeEngineeringStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadNarrativeText = (path: string) => Promise<string>;

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

function entriesValue(
  path: string,
  index: Record<string, unknown>,
  key: NarrativeCollectionKey,
): readonly Record<string, unknown>[] {
  const value = index[key];
  if (!Array.isArray(value)) throw new Error(`${path}.${key} 必须是数组`);
  return value.map((entry, position) =>
    objectValue(`${path}.${key}.${position}`, entry),
  );
}

export function narrativeRecordPath(
  key: NarrativeCollectionKey,
  id: string,
): string {
  return `${NARRATIVE_ENGINEERING_DIRECTORY}/${COLLECTION_SEGMENTS[key]}/records/${idValue(`${key} id`, id)}.json`;
}

export function narrativeLegacyArchivePath(): string {
  return `${NARRATIVE_ENGINEERING_DIRECTORY}/legacy/archive.json`;
}

function collectionFiles(
  key: NarrativeCollectionKey,
  records: readonly NarrativeStorageRecord[],
): {
  readonly entries: readonly { readonly id: string; readonly path: string }[];
  readonly files: readonly NarrativeEngineeringTextFile[];
} {
  const ids = new Set<string>();
  const files: NarrativeEngineeringTextFile[] = [];
  const entries = records.map((record, position) => {
    const id = idValue(`${key}.${position}.id`, record.id);
    if (ids.has(id)) throw new Error(`${key} 包含重复 id：${id}`);
    ids.add(id);
    const path = narrativeRecordPath(key, id);
    files.push({ path, content: json(record) });
    return { id, path };
  });
  return { entries, files };
}

/** 将剧情工程聚合拆成根索引与对象记录；返回顺序固定。 */
export function createNarrativeEngineeringFiles(
  library: NarrativeEngineeringStorageAggregate,
): readonly NarrativeEngineeringTextFile[] {
  if (library.schemaVersion !== NARRATIVE_ENGINEERING_SCHEMA_VERSION) {
    throw new Error(
      `剧情工程 schemaVersion 必须是 ${NARRATIVE_ENGINEERING_SCHEMA_VERSION}`,
    );
  }
  const collections = Object.fromEntries(
    (Object.keys(COLLECTION_SEGMENTS) as NarrativeCollectionKey[]).map(
      (key) => [key, collectionFiles(key, library[key] ?? [])],
    ),
  ) as Record<NarrativeCollectionKey, ReturnType<typeof collectionFiles>>;
  const files = (
    Object.keys(COLLECTION_SEGMENTS) as NarrativeCollectionKey[]
  ).flatMap((key) => collections[key].files);
  const legacyArchivePath =
    library.legacyArchive === undefined ? null : narrativeLegacyArchivePath();
  if (legacyArchivePath) {
    files.push({
      path: legacyArchivePath,
      content: json(library.legacyArchive),
    });
  }
  files.push({
    path: NARRATIVE_ENGINEERING_INDEX_PATH,
    content: json({
      schemaVersion: NARRATIVE_ENGINEERING_SCHEMA_VERSION,
      storageVersion: NARRATIVE_ENGINEERING_STORAGE_VERSION,
      updatedAt: library.updatedAt,
      lines: collections.lines.entries,
      arcs: collections.arcs.entries,
      directories: collections.directories.entries,
      chapters: collections.chapters.entries,
      simulationProposals: collections.simulationProposals.entries,
      legacyArchivePath,
    }),
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function loadCollection(
  read: ReadNarrativeText,
  index: Record<string, unknown>,
  key: NarrativeCollectionKey,
): Promise<readonly NarrativeStorageRecord[]> {
  const seen = new Set<string>();
  return Promise.all(
    entriesValue(NARRATIVE_ENGINEERING_INDEX_PATH, index, key).map(
      async (entry, position) => {
        const owner = `${NARRATIVE_ENGINEERING_INDEX_PATH}.${key}.${position}`;
        const id = idValue(`${owner}.id`, entry.id);
        if (seen.has(id)) throw new Error(`${key} 索引包含重复 id：${id}`);
        seen.add(id);
        const expectedPath = narrativeRecordPath(key, id);
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
        return record as unknown as NarrativeStorageRecord;
      },
    ),
  );
}

/** 从根索引递归读取所有剧情记录，并聚合成领域对象。 */
export async function loadNarrativeEngineeringFiles(
  readText: ReadNarrativeText,
): Promise<LoadedNarrativeEngineeringFiles> {
  const files = new Map<string, string>();
  const read: ReadNarrativeText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = objectValue(
    NARRATIVE_ENGINEERING_INDEX_PATH,
    parseJson(
      NARRATIVE_ENGINEERING_INDEX_PATH,
      await read(NARRATIVE_ENGINEERING_INDEX_PATH),
    ),
  );
  if (index.schemaVersion !== NARRATIVE_ENGINEERING_SCHEMA_VERSION) {
    throw new Error(
      `${NARRATIVE_ENGINEERING_INDEX_PATH}.schemaVersion 必须是 ${NARRATIVE_ENGINEERING_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== NARRATIVE_ENGINEERING_STORAGE_VERSION) {
    throw new Error(
      `${NARRATIVE_ENGINEERING_INDEX_PATH}.storageVersion 必须是 ${NARRATIVE_ENGINEERING_STORAGE_VERSION}；旧单文件剧情工程不兼容且不迁移`,
    );
  }
  if (typeof index.updatedAt !== "string" || !index.updatedAt) {
    throw new Error(
      `${NARRATIVE_ENGINEERING_INDEX_PATH}.updatedAt 必须是非空字符串`,
    );
  }
  const [lines, arcs, directories, chapters, simulationProposals] =
    await Promise.all([
      loadCollection(read, index, "lines"),
      loadCollection(read, index, "arcs"),
      loadCollection(read, index, "directories"),
      loadCollection(read, index, "chapters"),
      loadCollection(read, index, "simulationProposals"),
    ]);
  const legacyArchivePath = index.legacyArchivePath;
  if (
    legacyArchivePath !== null &&
    legacyArchivePath !== undefined &&
    legacyArchivePath !== narrativeLegacyArchivePath()
  ) {
    throw new Error(
      `${NARRATIVE_ENGINEERING_INDEX_PATH}.legacyArchivePath 必须是 ${narrativeLegacyArchivePath()} 或 null`,
    );
  }
  const legacyArchive =
    legacyArchivePath === narrativeLegacyArchivePath()
      ? parseJson(legacyArchivePath, await read(legacyArchivePath))
      : undefined;
  return {
    library: {
      schemaVersion: NARRATIVE_ENGINEERING_SCHEMA_VERSION,
      updatedAt: index.updatedAt,
      lines,
      arcs,
      directories,
      chapters,
      simulationProposals,
      ...(legacyArchive === undefined ? {} : { legacyArchive }),
    },
    files,
  };
}

/** 多文件内容的稳定表示，同时作为 sourceHash 输入和 Repository CAS 快照。 */
export function serializeNarrativeFileSnapshot(
  files: ReadonlyMap<string, string> | readonly NarrativeEngineeringTextFile[],
): string {
  const entries = Array.isArray(files)
    ? files.map((file) => [file.path, file.content] as const)
    : [...files.entries()];
  return JSON.stringify(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function narrativeFileMap(
  files: readonly NarrativeEngineeringTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content]));
}
