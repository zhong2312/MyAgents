import {
  CULTIVATION_ECOLOGY_SCHEMA_VERSION,
  cultivationEcologySchema,
  type CultivationEcology,
  type CultivationSystem,
  type TheoryModel,
} from "./cultivationEcologySchema";

export const CULTIVATION_ECOLOGY_DIRECTORY = "world/cultivation";
export const CULTIVATION_ECOLOGY_INDEX_PATH = `${CULTIVATION_ECOLOGY_DIRECTORY}/index.json`;
export const CULTIVATION_ECOLOGY_STORAGE_VERSION = 1 as const;

export interface CultivationEcologyTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedCultivationEcologyFiles {
  readonly ecology: CultivationEcology;
  readonly files: ReadonlyMap<string, string>;
}

type ReadCultivationText = (path: string) => Promise<string>;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

const COLLECTION_SEGMENTS = {
  progressionTracks: "progression",
  trackInteractions: "track-interactions",
  resources: "resources",
  methods: "methods",
  abilities: "abilities",
  formations: "formations",
  foundations: "foundations",
  transitions: "transitions",
  constraints: "constraints",
} as const satisfies Record<
  | "progressionTracks"
  | "trackInteractions"
  | "resources"
  | "methods"
  | "abilities"
  | "formations"
  | "foundations"
  | "transitions"
  | "constraints",
  string
>;

type SystemCollectionKey = keyof typeof COLLECTION_SEGMENTS;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(
      `${path} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function record(path: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function stringValue(
  ownerPath: string,
  value: Record<string, unknown>,
  key: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) {
    throw new Error(`${ownerPath}.${key} 必须是非空字符串`);
  }
  return result;
}

function idValue(
  ownerPath: string,
  value: Record<string, unknown>,
  key = "id",
): string {
  const id = stringValue(ownerPath, value, key);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${ownerPath}.${key} 只能使用小写字母、数字和连字符`);
  }
  return id;
}

function arrayValue(
  ownerPath: string,
  value: Record<string, unknown>,
  key: string,
): unknown[] {
  const result = value[key];
  if (!Array.isArray(result)) throw new Error(`${ownerPath}.${key} 必须是数组`);
  return result;
}

function assertExactPath(
  ownerPath: string,
  actual: unknown,
  expected: string,
): string {
  if (actual !== expected) {
    throw new Error(`${ownerPath} 必须是 ${expected}`);
  }
  return expected;
}

function originPath(id: string): string {
  return `${CULTIVATION_ECOLOGY_DIRECTORY}/origins/records/${id}.json`;
}

function relationPath(id: string): string {
  return `${CULTIVATION_ECOLOGY_DIRECTORY}/relations/records/${id}.json`;
}

function relationsIndexPath(): string {
  return `${CULTIVATION_ECOLOGY_DIRECTORY}/relations/index.json`;
}

function systemDirectory(id: string): string {
  return `${CULTIVATION_ECOLOGY_DIRECTORY}/systems/${id}`;
}

function systemPath(id: string): string {
  return `${systemDirectory(id)}/system.json`;
}

function systemModulePath(id: string, module: string): string {
  return `${systemDirectory(id)}/${module}.json`;
}

function collectionIndexPath(systemId: string, segment: string): string {
  return `${systemDirectory(systemId)}/${segment}/index.json`;
}

function collectionRecordPath(
  systemId: string,
  segment: string,
  id: string,
): string {
  return `${systemDirectory(systemId)}/${segment}/records/${id}.json`;
}

function theoryIndexPath(systemId: string): string {
  return `${systemDirectory(systemId)}/theory/index.json`;
}

function theoryNodePath(systemId: string, nodeId: string): string {
  return `${systemDirectory(systemId)}/theory/nodes/${nodeId}.json`;
}

function entry(
  value: {
    id: string;
    name: string;
    summary: string;
  },
  path: string,
): Record<string, unknown> {
  return {
    id: value.id,
    name: value.name,
    summary: value.summary,
    path,
  };
}

function addCollectionFiles(
  files: CultivationEcologyTextFile[],
  systemId: string,
  key: SystemCollectionKey,
  items: readonly { id: string; name: string; summary: string }[],
): void {
  const segment = COLLECTION_SEGMENTS[key];
  const entries = items.map((item) => {
    const path = collectionRecordPath(systemId, segment, item.id);
    files.push({ path, content: json(item) });
    return entry(item, path);
  });
  files.push({
    path: collectionIndexPath(systemId, segment),
    content: json({ schemaVersion: 1, entries }),
  });
}

function addTheoryFiles(
  files: CultivationEcologyTextFile[],
  systemId: string,
  theory: TheoryModel,
): void {
  const { nodeCatalog, ...definition } = theory;
  const nodes = nodeCatalog.map((node) => {
    const path = theoryNodePath(systemId, node.id);
    files.push({ path, content: json(node) });
    return entry(node, path);
  });
  files.push({
    path: theoryIndexPath(systemId),
    content: json({ schemaVersion: 1, ...definition, nodes }),
  });
}

function addSystemFiles(
  files: CultivationEcologyTextFile[],
  system: CultivationSystem,
): void {
  const base = systemDirectory(system.id);
  files.push({
    path: systemPath(system.id),
    content: json({
      schemaVersion: 1,
      id: system.id,
      name: system.name,
      summary: system.summary,
      kind: system.kind,
      terminology: system.terminology,
      narrativeMilestones: system.narrativeMilestones,
      modules: {
        projection: `${base}/projection.json`,
        theory: `${base}/theory/index.json`,
        progression: `${base}/progression/index.json`,
        trackInteractions: `${base}/track-interactions/index.json`,
        resources: `${base}/resources/index.json`,
        methods: `${base}/methods/index.json`,
        abilities: `${base}/abilities/index.json`,
        formations: `${base}/formations/index.json`,
        foundations: `${base}/foundations/index.json`,
        transitions: `${base}/transitions/index.json`,
        constraints: `${base}/constraints/index.json`,
        audit: `${base}/audit.json`,
      },
    }),
  });
  files.push({
    path: systemModulePath(system.id, "projection"),
    content: json(system.projection),
  });
  addTheoryFiles(files, system.id, system.theoryModel);
  (Object.keys(COLLECTION_SEGMENTS) as SystemCollectionKey[]).forEach((key) =>
    addCollectionFiles(files, system.id, key, system[key]),
  );
  files.push({
    path: systemModulePath(system.id, "audit"),
    content: json(system.audit),
  });
}

/**
 * 将领域聚合拆成目录化事实文件。返回顺序固定，便于比较、测试和提案生成。
 */
export function createCultivationEcologyFiles(
  ecology: CultivationEcology,
): readonly CultivationEcologyTextFile[] {
  const checked = cultivationEcologySchema.parse(ecology);
  const files: CultivationEcologyTextFile[] = [];
  const origins = checked.worldOrigins.map((origin) => {
    const path = originPath(origin.id);
    files.push({ path, content: json(origin) });
    return {
      ...entry(origin, path),
      kind: origin.kind,
      status: origin.status,
    };
  });
  const systems = checked.systems.map((system) => {
    addSystemFiles(files, system);
    return {
      ...entry(system, systemPath(system.id)),
      kind: system.kind,
    };
  });
  const relationEntries = checked.crossSystemRelations.map((relation) => {
    const path = relationPath(relation.id);
    files.push({ path, content: json(relation) });
    return entry(relation, path);
  });
  files.push({
    path: relationsIndexPath(),
    content: json({ schemaVersion: 1, entries: relationEntries }),
  });
  files.push({
    path: CULTIVATION_ECOLOGY_INDEX_PATH,
    content: json({
      schemaVersion: CULTIVATION_ECOLOGY_STORAGE_VERSION,
      ecologySchemaVersion: CULTIVATION_ECOLOGY_SCHEMA_VERSION,
      updatedAt: checked.updatedAt,
      origins,
      systems,
      crossSystemRelationsPath: relationsIndexPath(),
    }),
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function parseEntryList(
  indexPath: string,
  index: Record<string, unknown>,
  key: string,
): readonly Record<string, unknown>[] {
  return arrayValue(indexPath, index, key).map((value, position) =>
    record(`${indexPath}.${key}.${position}`, value),
  );
}

async function loadEntryRecords(
  trackedRead: ReadCultivationText,
  indexPath: string,
  expectedRecordPath: (id: string) => string,
): Promise<unknown[]> {
  const index = record(
    indexPath,
    parseJson(indexPath, await trackedRead(indexPath)),
  );
  return Promise.all(
    parseEntryList(indexPath, index, "entries").map(async (item, position) => {
      const owner = `${indexPath}.entries.${position}`;
      const id = idValue(owner, item);
      const path = assertExactPath(
        `${owner}.path`,
        item.path,
        expectedRecordPath(id),
      );
      const value = parseJson(path, await trackedRead(path));
      const parsedRecord = record(path, value);
      if (idValue(path, parsedRecord) !== id) {
        throw new Error(`${path}.id 与索引中的 ${id} 不一致`);
      }
      return value;
    }),
  );
}

async function loadTheory(
  trackedRead: ReadCultivationText,
  systemId: string,
): Promise<unknown> {
  const path = theoryIndexPath(systemId);
  const index = record(path, parseJson(path, await trackedRead(path)));
  const nodes = await Promise.all(
    parseEntryList(path, index, "nodes").map(async (item, position) => {
      const owner = `${path}.nodes.${position}`;
      const nodeId = idValue(owner, item);
      const nodePath = assertExactPath(
        `${owner}.path`,
        item.path,
        theoryNodePath(systemId, nodeId),
      );
      const node = parseJson(nodePath, await trackedRead(nodePath));
      if (idValue(nodePath, record(nodePath, node)) !== nodeId) {
        throw new Error(`${nodePath}.id 与理论节点索引不一致`);
      }
      return node;
    }),
  );
  const { schemaVersion: _schemaVersion, nodes: _nodes, ...definition } = index;
  return { ...definition, nodeCatalog: nodes };
}

async function loadSystem(
  trackedRead: ReadCultivationText,
  id: string,
): Promise<unknown> {
  const path = systemPath(id);
  const systemFile = record(path, parseJson(path, await trackedRead(path)));
  if (idValue(path, systemFile) !== id) {
    throw new Error(`${path}.id 与修行体系索引不一致`);
  }
  const modules = record(`${path}.modules`, systemFile.modules);
  const projectionPath = systemModulePath(id, "projection");
  const auditPath = systemModulePath(id, "audit");
  assertExactPath(
    `${path}.modules.projection`,
    modules.projection,
    projectionPath,
  );
  assertExactPath(
    `${path}.modules.theory`,
    modules.theory,
    theoryIndexPath(id),
  );
  assertExactPath(`${path}.modules.audit`, modules.audit, auditPath);
  for (const [key, segment] of Object.entries(COLLECTION_SEGMENTS) as [
    SystemCollectionKey,
    string,
  ][]) {
    assertExactPath(
      `${path}.modules.${key}`,
      modules[key === "progressionTracks" ? "progression" : key],
      collectionIndexPath(id, segment),
    );
  }
  const collections = await Promise.all(
    (
      Object.entries(COLLECTION_SEGMENTS) as [SystemCollectionKey, string][]
    ).map(
      async ([key, segment]) =>
        [
          key,
          await loadEntryRecords(
            trackedRead,
            collectionIndexPath(id, segment),
            (recordId) => collectionRecordPath(id, segment, recordId),
          ),
        ] as const,
    ),
  );
  const {
    schemaVersion: _schemaVersion,
    modules: _modules,
    ...definition
  } = systemFile;
  return {
    ...definition,
    projection: parseJson(projectionPath, await trackedRead(projectionPath)),
    theoryModel: await loadTheory(trackedRead, id),
    ...Object.fromEntries(collections),
    audit: parseJson(auditPath, await trackedRead(auditPath)),
  };
}

/** 从根索引递归读取目录化事实源，并聚合成界面使用的领域对象。 */
export async function loadCultivationEcologyFiles(
  readText: ReadCultivationText,
): Promise<LoadedCultivationEcologyFiles> {
  const files = new Map<string, string>();
  const trackedRead: ReadCultivationText = async (path) => {
    const existing = files.get(path);
    if (existing !== undefined) return existing;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const rootContent = await trackedRead(CULTIVATION_ECOLOGY_INDEX_PATH);
  const root = record(
    CULTIVATION_ECOLOGY_INDEX_PATH,
    parseJson(CULTIVATION_ECOLOGY_INDEX_PATH, rootContent),
  );
  if (root.schemaVersion !== CULTIVATION_ECOLOGY_STORAGE_VERSION) {
    throw new Error(
      `${CULTIVATION_ECOLOGY_INDEX_PATH}.schemaVersion 必须是 ${CULTIVATION_ECOLOGY_STORAGE_VERSION}`,
    );
  }
  if (root.ecologySchemaVersion !== CULTIVATION_ECOLOGY_SCHEMA_VERSION) {
    throw new Error(
      `${CULTIVATION_ECOLOGY_INDEX_PATH}.ecologySchemaVersion 必须是 ${CULTIVATION_ECOLOGY_SCHEMA_VERSION}`,
    );
  }
  assertExactPath(
    `${CULTIVATION_ECOLOGY_INDEX_PATH}.crossSystemRelationsPath`,
    root.crossSystemRelationsPath,
    relationsIndexPath(),
  );
  const origins = await Promise.all(
    parseEntryList(CULTIVATION_ECOLOGY_INDEX_PATH, root, "origins").map(
      async (item, position) => {
        const owner = `${CULTIVATION_ECOLOGY_INDEX_PATH}.origins.${position}`;
        const id = idValue(owner, item);
        const path = assertExactPath(
          `${owner}.path`,
          item.path,
          originPath(id),
        );
        const origin = parseJson(path, await trackedRead(path));
        if (idValue(path, record(path, origin)) !== id) {
          throw new Error(`${path}.id 与世界本源索引不一致`);
        }
        return origin;
      },
    ),
  );
  const systems = await Promise.all(
    parseEntryList(CULTIVATION_ECOLOGY_INDEX_PATH, root, "systems").map(
      async (item, position) => {
        const owner = `${CULTIVATION_ECOLOGY_INDEX_PATH}.systems.${position}`;
        const id = idValue(owner, item);
        assertExactPath(`${owner}.path`, item.path, systemPath(id));
        return loadSystem(trackedRead, id);
      },
    ),
  );
  const crossSystemRelations = await loadEntryRecords(
    trackedRead,
    relationsIndexPath(),
    relationPath,
  );
  const checked = cultivationEcologySchema.safeParse({
    schemaVersion: root.ecologySchemaVersion,
    worldOrigins: origins,
    systems,
    crossSystemRelations,
    updatedAt: stringValue(CULTIVATION_ECOLOGY_INDEX_PATH, root, "updatedAt"),
  });
  if (!checked.success) {
    throw new Error(
      checked.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return { ecology: checked.data, files };
}

/** 精确表示一次多文件读取快照，供并发保存和 AI sourceHash 使用。 */
export function serializeCultivationFileSnapshot(
  files: ReadonlyMap<string, string> | readonly CultivationEcologyTextFile[],
): string {
  const entries = Array.isArray(files)
    ? files.map((file) => [file.path, file.content] as const)
    : [...files.entries()];
  return JSON.stringify(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function cultivationFileMap(
  files: readonly CultivationEcologyTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content]));
}
