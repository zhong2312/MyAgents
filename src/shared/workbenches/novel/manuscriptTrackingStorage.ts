export const MANUSCRIPT_TRACKING_DIRECTORY = "manuscript/state-ledger";
export const MANUSCRIPT_TRACKING_INDEX_PATH =
  "manuscript/state-ledger/index.json";
export const MANUSCRIPT_TRACKING_BASELINES_PATH =
  "manuscript/state-ledger/baselines.json";
export const MANUSCRIPT_TRACKING_BATCHES_DIRECTORY =
  "manuscript/state-ledger/batches";
export const MANUSCRIPT_TRACKING_LEGACY_PATH = "manuscript/state-ledger.json";
export const MANUSCRIPT_TRACKING_STORAGE_VERSION = 1 as const;
export const MANUSCRIPT_TRACKING_SCHEMA_VERSION = 3 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface ManuscriptTrackingStorageBatch {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface ManuscriptTrackingStorageAggregate {
  readonly schemaVersion: typeof MANUSCRIPT_TRACKING_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly baselines: Readonly<Record<string, unknown | null>>;
  readonly batches: readonly ManuscriptTrackingStorageBatch[];
}

export interface ManuscriptTrackingTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedManuscriptTrackingFiles {
  readonly ledger: ManuscriptTrackingStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadManuscriptTrackingText = (path: string) => Promise<string>;

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

export function manuscriptTrackingBatchPath(id: string): string {
  return `${MANUSCRIPT_TRACKING_BATCHES_DIRECTORY}/${idValue("tracking batch id", id)}.json`;
}

function createBatchFiles(batches: readonly ManuscriptTrackingStorageBatch[]): {
  readonly entries: readonly { readonly id: string; readonly path: string }[];
  readonly files: readonly ManuscriptTrackingTextFile[];
} {
  const ids = new Set<string>();
  const files: ManuscriptTrackingTextFile[] = [];
  const entries = batches.map((batch, position) => {
    const id = idValue(`batches.${position}.id`, batch.id);
    if (ids.has(id)) throw new Error(`batches 包含重复 id：${id}`);
    ids.add(id);
    const path = manuscriptTrackingBatchPath(id);
    files.push({ path, content: json(batch) });
    return { id, path };
  });
  return { entries, files };
}

/** 将逻辑账本拆成全局基线、独立批次和轻量根索引；根索引固定最后返回。 */
export function createManuscriptTrackingFiles(
  ledger: ManuscriptTrackingStorageAggregate,
): readonly ManuscriptTrackingTextFile[] {
  if (ledger.schemaVersion !== MANUSCRIPT_TRACKING_SCHEMA_VERSION) {
    throw new Error(
      `正文状态账本 schemaVersion 必须是 ${MANUSCRIPT_TRACKING_SCHEMA_VERSION}`,
    );
  }
  const updatedAt = updatedAtValue("tracking.updatedAt", ledger.updatedAt);
  const batches = createBatchFiles(ledger.batches);
  const files = [...batches.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  files.push({
    path: MANUSCRIPT_TRACKING_BASELINES_PATH,
    content: json({ schemaVersion: 1, baselines: ledger.baselines }),
  });
  files.push({
    path: MANUSCRIPT_TRACKING_INDEX_PATH,
    content: json({
      schemaVersion: MANUSCRIPT_TRACKING_SCHEMA_VERSION,
      storageVersion: MANUSCRIPT_TRACKING_STORAGE_VERSION,
      updatedAt,
      baselinesPath: MANUSCRIPT_TRACKING_BASELINES_PATH,
      batches: batches.entries,
    }),
  });
  return files;
}

async function loadBatches(
  read: ReadManuscriptTrackingText,
  index: Record<string, unknown>,
): Promise<readonly ManuscriptTrackingStorageBatch[]> {
  const entries = index.batches;
  if (!Array.isArray(entries)) {
    throw new Error(`${MANUSCRIPT_TRACKING_INDEX_PATH}.batches 必须是数组`);
  }
  const ids = new Set<string>();
  return Promise.all(
    entries.map(async (entry, position) => {
      const owner = `${MANUSCRIPT_TRACKING_INDEX_PATH}.batches.${position}`;
      const reference = objectValue(owner, entry);
      const id = idValue(`${owner}.id`, reference.id);
      if (ids.has(id)) throw new Error(`batches 索引包含重复 id：${id}`);
      ids.add(id);
      const expectedPath = manuscriptTrackingBatchPath(id);
      if (reference.path !== expectedPath) {
        throw new Error(`${owner}.path 必须是 ${expectedPath}`);
      }
      const batch = objectValue(
        expectedPath,
        parseJson(expectedPath, await read(expectedPath)),
      );
      if (idValue(`${expectedPath}.id`, batch.id) !== id) {
        throw new Error(`${expectedPath}.id 与索引不一致`);
      }
      return batch as ManuscriptTrackingStorageBatch;
    }),
  );
}

/** 从根索引递归读取基线和批次记录，并聚合现有业务层使用的完整账本。 */
export async function loadManuscriptTrackingFiles(
  readText: ReadManuscriptTrackingText,
): Promise<LoadedManuscriptTrackingFiles> {
  const files = new Map<string, string>();
  const read: ReadManuscriptTrackingText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = objectValue(
    MANUSCRIPT_TRACKING_INDEX_PATH,
    parseJson(
      MANUSCRIPT_TRACKING_INDEX_PATH,
      await read(MANUSCRIPT_TRACKING_INDEX_PATH),
    ),
  );
  if (index.schemaVersion !== MANUSCRIPT_TRACKING_SCHEMA_VERSION) {
    throw new Error(
      `${MANUSCRIPT_TRACKING_INDEX_PATH}.schemaVersion 必须是 ${MANUSCRIPT_TRACKING_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== MANUSCRIPT_TRACKING_STORAGE_VERSION) {
    throw new Error(
      `${MANUSCRIPT_TRACKING_INDEX_PATH}.storageVersion 必须是 ${MANUSCRIPT_TRACKING_STORAGE_VERSION}；旧单文件正文状态账本不兼容且不迁移`,
    );
  }
  if (index.baselinesPath !== MANUSCRIPT_TRACKING_BASELINES_PATH) {
    throw new Error(
      `${MANUSCRIPT_TRACKING_INDEX_PATH}.baselinesPath 必须是 ${MANUSCRIPT_TRACKING_BASELINES_PATH}`,
    );
  }
  const baselineFile = objectValue(
    MANUSCRIPT_TRACKING_BASELINES_PATH,
    parseJson(
      MANUSCRIPT_TRACKING_BASELINES_PATH,
      await read(MANUSCRIPT_TRACKING_BASELINES_PATH),
    ),
  );
  if (baselineFile.schemaVersion !== 1) {
    throw new Error(
      `${MANUSCRIPT_TRACKING_BASELINES_PATH}.schemaVersion 必须是 1`,
    );
  }
  const baselines = objectValue(
    `${MANUSCRIPT_TRACKING_BASELINES_PATH}.baselines`,
    baselineFile.baselines,
  );
  return {
    ledger: {
      schemaVersion: MANUSCRIPT_TRACKING_SCHEMA_VERSION,
      updatedAt: updatedAtValue(
        `${MANUSCRIPT_TRACKING_INDEX_PATH}.updatedAt`,
        index.updatedAt,
      ),
      baselines,
      batches: await loadBatches(read, index),
    },
    files,
  };
}

export function manuscriptTrackingFileMap(
  files: readonly ManuscriptTrackingTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

/** 精确表示一次多文件读取快照，供并发保存和上下文 sourceHash 使用。 */
export function serializeManuscriptTrackingFileSnapshot(
  files: ReadonlyMap<string, string> | readonly ManuscriptTrackingTextFile[],
): string {
  const entries = Array.isArray(files)
    ? files.map((file) => [file.path, file.content] as const)
    : [...files.entries()];
  return JSON.stringify(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}
