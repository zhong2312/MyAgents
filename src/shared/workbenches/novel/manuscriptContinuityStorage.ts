export const MANUSCRIPT_CONTINUITY_DIRECTORY = "manuscript/continuity-state";
export const MANUSCRIPT_CONTINUITY_INDEX_PATH =
  "manuscript/continuity-state/index.json";
export const MANUSCRIPT_CONTINUITY_FACTS_DIRECTORY =
  "manuscript/continuity-state/facts";
export const MANUSCRIPT_CONTINUITY_LEGACY_PATH =
  "manuscript/continuity-state.json";
export const MANUSCRIPT_CONTINUITY_STORAGE_VERSION = 1 as const;
export const MANUSCRIPT_CONTINUITY_SCHEMA_VERSION = 1 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface ManuscriptContinuityStorageFact {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface ManuscriptContinuityStorageAggregate {
  readonly schemaVersion: typeof MANUSCRIPT_CONTINUITY_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly facts: readonly ManuscriptContinuityStorageFact[];
}

export interface ManuscriptContinuityTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedManuscriptContinuityFiles {
  readonly state: ManuscriptContinuityStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadManuscriptContinuityText = (path: string) => Promise<string>;

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

export function manuscriptContinuityFactPath(id: string): string {
  return `${MANUSCRIPT_CONTINUITY_FACTS_DIRECTORY}/${idValue("continuity fact id", id)}.json`;
}

function createFactFiles(facts: readonly ManuscriptContinuityStorageFact[]): {
  readonly entries: readonly { readonly id: string; readonly path: string }[];
  readonly files: readonly ManuscriptContinuityTextFile[];
} {
  const ids = new Set<string>();
  const files: ManuscriptContinuityTextFile[] = [];
  const entries = facts.map((fact, position) => {
    const id = idValue(`facts.${position}.id`, fact.id);
    if (ids.has(id)) throw new Error(`facts 包含重复 id：${id}`);
    ids.add(id);
    const path = manuscriptContinuityFactPath(id);
    files.push({ path, content: json(fact) });
    return { id, path };
  });
  return { entries, files };
}

/** 将连续性事实拆成独立记录和轻量根索引；根索引固定最后返回。 */
export function createManuscriptContinuityFiles(
  state: ManuscriptContinuityStorageAggregate,
): readonly ManuscriptContinuityTextFile[] {
  if (state.schemaVersion !== MANUSCRIPT_CONTINUITY_SCHEMA_VERSION) {
    throw new Error(
      `正文连续性 schemaVersion 必须是 ${MANUSCRIPT_CONTINUITY_SCHEMA_VERSION}`,
    );
  }
  const updatedAt = updatedAtValue("continuity.updatedAt", state.updatedAt);
  const facts = createFactFiles(state.facts);
  const files = [...facts.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  files.push({
    path: MANUSCRIPT_CONTINUITY_INDEX_PATH,
    content: json({
      schemaVersion: MANUSCRIPT_CONTINUITY_SCHEMA_VERSION,
      storageVersion: MANUSCRIPT_CONTINUITY_STORAGE_VERSION,
      updatedAt,
      facts: facts.entries,
    }),
  });
  return files;
}

async function loadFacts(
  read: ReadManuscriptContinuityText,
  index: Record<string, unknown>,
): Promise<readonly ManuscriptContinuityStorageFact[]> {
  const entries = index.facts;
  if (!Array.isArray(entries)) {
    throw new Error(`${MANUSCRIPT_CONTINUITY_INDEX_PATH}.facts 必须是数组`);
  }
  const ids = new Set<string>();
  return Promise.all(
    entries.map(async (entry, position) => {
      const owner = `${MANUSCRIPT_CONTINUITY_INDEX_PATH}.facts.${position}`;
      const reference = objectValue(owner, entry);
      const id = idValue(`${owner}.id`, reference.id);
      if (ids.has(id)) throw new Error(`facts 索引包含重复 id：${id}`);
      ids.add(id);
      const expectedPath = manuscriptContinuityFactPath(id);
      if (reference.path !== expectedPath) {
        throw new Error(`${owner}.path 必须是 ${expectedPath}`);
      }
      const fact = objectValue(
        expectedPath,
        parseJson(expectedPath, await read(expectedPath)),
      );
      if (idValue(`${expectedPath}.id`, fact.id) !== id) {
        throw new Error(`${expectedPath}.id 与索引不一致`);
      }
      return fact as ManuscriptContinuityStorageFact;
    }),
  );
}

/** 从根索引读取全部连续性事实并聚合成现有业务层使用的状态对象。 */
export async function loadManuscriptContinuityFiles(
  readText: ReadManuscriptContinuityText,
): Promise<LoadedManuscriptContinuityFiles> {
  const files = new Map<string, string>();
  const read: ReadManuscriptContinuityText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = objectValue(
    MANUSCRIPT_CONTINUITY_INDEX_PATH,
    parseJson(
      MANUSCRIPT_CONTINUITY_INDEX_PATH,
      await read(MANUSCRIPT_CONTINUITY_INDEX_PATH),
    ),
  );
  if (index.schemaVersion !== MANUSCRIPT_CONTINUITY_SCHEMA_VERSION) {
    throw new Error(
      `${MANUSCRIPT_CONTINUITY_INDEX_PATH}.schemaVersion 必须是 ${MANUSCRIPT_CONTINUITY_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== MANUSCRIPT_CONTINUITY_STORAGE_VERSION) {
    throw new Error(
      `${MANUSCRIPT_CONTINUITY_INDEX_PATH}.storageVersion 必须是 ${MANUSCRIPT_CONTINUITY_STORAGE_VERSION}；旧单文件连续性状态不兼容且不迁移`,
    );
  }
  return {
    state: {
      schemaVersion: MANUSCRIPT_CONTINUITY_SCHEMA_VERSION,
      updatedAt: updatedAtValue(
        `${MANUSCRIPT_CONTINUITY_INDEX_PATH}.updatedAt`,
        index.updatedAt,
      ),
      facts: await loadFacts(read, index),
    },
    files,
  };
}

export function manuscriptContinuityFileMap(
  files: readonly ManuscriptContinuityTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

/** 精确表示一次多文件读取快照，供连续性投影 CAS 和 sourceHash 使用。 */
export function serializeManuscriptContinuityFileSnapshot(
  files: ReadonlyMap<string, string> | readonly ManuscriptContinuityTextFile[],
): string {
  const entries = Array.isArray(files)
    ? files.map((file) => [file.path, file.content] as const)
    : [...files.entries()];
  return JSON.stringify(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}
