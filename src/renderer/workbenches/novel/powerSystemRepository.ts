import type { WorkbenchStorage } from "@/workbench-sdk";
import { validatePowerSystemLibrary } from "../../../shared/novel-power-system-validation";

import {
  createDefaultPowerSystemMeta,
  createEmptyPowerCatalog,
  createEmptyPowerConnections,
  createEmptyPowerSystemIndex,
  createPowerSystemRecord,
} from "./powerSystemDefaults";
import {
  parsePowerCatalog,
  parsePowerConnections,
  parsePowerSystemIndex,
  parsePowerSystemMeta,
  parsePowerSystemRecord,
  serializePowerSystemFile,
  type PowerCatalog,
  type PowerConnections,
  type PowerSystemIndex,
  type PowerSystemIndexEntry,
  type PowerSystemMeta,
  type PowerSystemRecord,
} from "./powerSystemSchema";

export const POWER_SYSTEM_PATHS = Object.freeze({
  root: "world/power-systems",
  meta: "world/power-systems/meta.json",
  index: "world/power-systems/index.json",
  catalog: "world/power-systems/catalog.json",
  connections: "world/power-systems/connections.json",
  records: "world/power-systems/records",
  pages: "world/power-systems/pages",
  proposals: "world/power-systems/proposals",
});

export interface LoadedPowerSystemLibrary {
  readonly meta: PowerSystemMeta;
  readonly metaContent: string;
  readonly index: PowerSystemIndex;
  readonly indexContent: string;
  readonly catalog: PowerCatalog;
  readonly catalogContent: string;
  readonly connections: PowerConnections;
  readonly connectionsContent: string;
}

export interface LoadedPowerSystem {
  readonly record: PowerSystemRecord;
  readonly recordContent: string;
  readonly pageContent: string;
}

export interface NovelPowerSystemRepository {
  isInitialized(): Promise<boolean>;
  initialize(): Promise<LoadedPowerSystemLibrary>;
  load(): Promise<LoadedPowerSystemLibrary | null>;
  loadSystem(entry: PowerSystemIndexEntry): Promise<LoadedPowerSystem>;
  createSystem(
    library: LoadedPowerSystemLibrary,
    input: {
      readonly id: string;
      readonly name: string;
      readonly typeId: string;
    },
  ): Promise<{
    readonly library: LoadedPowerSystemLibrary;
    readonly system: LoadedPowerSystem;
  }>;
  saveSystem(
    library: LoadedPowerSystemLibrary,
    system: LoadedPowerSystem,
    record: PowerSystemRecord,
    pageContent: string,
  ): Promise<{
    readonly library: LoadedPowerSystemLibrary;
    readonly system: LoadedPowerSystem;
  }>;
  saveWorkspace(
    library: LoadedPowerSystemLibrary,
    system: LoadedPowerSystem | null,
    changes: {
      readonly record?: PowerSystemRecord;
      readonly pageContent?: string;
      readonly catalog?: PowerCatalog;
      readonly connections?: PowerConnections;
    },
  ): Promise<{
    readonly library: LoadedPowerSystemLibrary;
    readonly system: LoadedPowerSystem | null;
  }>;
  saveCatalog(
    library: LoadedPowerSystemLibrary,
    catalog: PowerCatalog,
  ): Promise<LoadedPowerSystemLibrary>;
  saveConnections(
    library: LoadedPowerSystemLibrary,
    connections: PowerConnections,
  ): Promise<LoadedPowerSystemLibrary>;
  saveLibrary(
    library: LoadedPowerSystemLibrary,
    catalog: PowerCatalog,
    connections: PowerConnections,
  ): Promise<LoadedPowerSystemLibrary>;
}

function systemPaths(id: string) {
  return {
    recordPath: `${POWER_SYSTEM_PATHS.records}/${id}.json`,
    pagePath: `${POWER_SYSTEM_PATHS.pages}/${id}.md`,
  } as const;
}

function toIndexEntry(record: PowerSystemRecord): PowerSystemIndexEntry {
  return {
    id: record.id,
    name: record.name,
    typeId: record.typeId,
    status: record.status,
    summary: record.summary,
    ...systemPaths(record.id),
    updatedAt: record.updatedAt,
  };
}

function replaceLibrary(
  library: LoadedPowerSystemLibrary,
  patch: Partial<LoadedPowerSystemLibrary>,
): LoadedPowerSystemLibrary {
  return Object.freeze({ ...library, ...patch });
}

export function createPowerSystemInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: POWER_SYSTEM_PATHS.meta,
      content: serializePowerSystemFile(createDefaultPowerSystemMeta()),
    },
    {
      path: POWER_SYSTEM_PATHS.index,
      content: serializePowerSystemFile(createEmptyPowerSystemIndex()),
    },
    {
      path: POWER_SYSTEM_PATHS.catalog,
      content: serializePowerSystemFile(createEmptyPowerCatalog()),
    },
    {
      path: POWER_SYSTEM_PATHS.connections,
      content: serializePowerSystemFile(createEmptyPowerConnections()),
    },
  ];
}

function catalogKinds(catalog: PowerCatalog): Map<string, string> {
  return new Map(
    [
      ...catalog.foundations,
      ...catalog.mediums,
      ...catalog.principles,
      ...catalog.resources,
      ...catalog.theories,
      ...catalog.methods,
      ...catalog.capabilities,
    ].map((item) => [item.id, item.kind] as const),
  );
}

function validateLibrary(library: LoadedPowerSystemLibrary) {
  const typeIds = new Set(library.meta.systemTypes.map((type) => type.id));
  const systemIds = new Set<string>();
  library.index.systems.forEach((entry) => {
    if (systemIds.has(entry.id)) {
      throw new Error(`力量体系 id 重复：${entry.id}`);
    }
    systemIds.add(entry.id);
    if (!typeIds.has(entry.typeId)) {
      throw new Error(`力量体系“${entry.name}”引用了不存在的体系类型`);
    }
  });
  const kinds = catalogKinds(library.catalog);
  library.catalog.theories.forEach((theory) => {
    theory.substrateRefs.forEach((reference) => {
      if (
        reference.namespace === "catalog" &&
        kinds.get(reference.targetId) !== reference.kind
      ) {
        throw new Error(`理论“${theory.name}”引用了不存在或类型不符的承载对象`);
      }
      if (
        reference.namespace === "system" &&
        !systemIds.has(reference.systemId)
      ) {
        throw new Error(`理论“${theory.name}”引用了不存在的力量体系`);
      }
    });
  });
  library.connections.connections.forEach((connection) => {
    for (const endpoint of [connection.source, connection.target]) {
      if (
        endpoint.namespace === "catalog" &&
        kinds.get(endpoint.targetId) !== endpoint.kind
      ) {
        throw new Error(
          `连接“${connection.id}”引用了不存在或类型不符的共享对象`,
        );
      }
      if (
        endpoint.namespace === "system" &&
        !systemIds.has(endpoint.systemId)
      ) {
        throw new Error(
          `连接“${connection.id}”引用了不存在的力量体系：${endpoint.systemId}`,
        );
      }
      if (
        endpoint.namespace === "system" &&
        endpoint.kind === "system" &&
        endpoint.targetId !== endpoint.systemId
      ) {
        throw new Error(`连接“${connection.id}”的体系引用 id 不一致`);
      }
    }
  });
}

async function readLibrary(
  storage: WorkbenchStorage,
): Promise<LoadedPowerSystemLibrary> {
  const [metaFile, indexFile, catalogFile, connectionsFile] = await Promise.all(
    [
      storage.readText(POWER_SYSTEM_PATHS.meta),
      storage.readText(POWER_SYSTEM_PATHS.index),
      storage.readText(POWER_SYSTEM_PATHS.catalog),
      storage.readText(POWER_SYSTEM_PATHS.connections),
    ],
  );
  const library: LoadedPowerSystemLibrary = Object.freeze({
    meta: parsePowerSystemMeta(metaFile.content),
    metaContent: metaFile.content,
    index: parsePowerSystemIndex(indexFile.content),
    indexContent: indexFile.content,
    catalog: parsePowerCatalog(catalogFile.content),
    catalogContent: catalogFile.content,
    connections: parsePowerConnections(connectionsFile.content),
    connectionsContent: connectionsFile.content,
  });
  validateLibrary(library);
  return library;
}

async function loadLibraryRecords(
  storage: WorkbenchStorage,
  index: PowerSystemIndex,
  override?: PowerSystemRecord,
): Promise<Map<string, PowerSystemRecord>> {
  const records = new Map<string, PowerSystemRecord>();
  await Promise.all(
    index.systems.map(async (entry) => {
      if (override?.id === entry.id) {
        records.set(entry.id, override);
        return;
      }
      const file = await storage.readText(entry.recordPath);
      records.set(
        entry.id,
        parsePowerSystemRecord(entry.recordPath, file.content),
      );
    }),
  );
  return records;
}

async function validateLibraryReferences(
  storage: WorkbenchStorage,
  library: LoadedPowerSystemLibrary,
  override?: PowerSystemRecord,
): Promise<void> {
  validateLibrary(library);
  const records = await loadLibraryRecords(storage, library.index, override);
  const errors = validatePowerSystemLibrary({ ...library, records });
  if (errors.length > 0) throw new Error(errors.join("；"));
}

export function createNovelPowerSystemRepository(
  storage: WorkbenchStorage,
): NovelPowerSystemRepository {
  const repository: NovelPowerSystemRepository = {
    async isInitialized() {
      const entries = await storage.stat([
        POWER_SYSTEM_PATHS.meta,
        POWER_SYSTEM_PATHS.index,
        POWER_SYSTEM_PATHS.catalog,
        POWER_SYSTEM_PATHS.connections,
      ]);
      return entries.every((entry) => entry.exists && entry.kind === "file");
    },

    async initialize() {
      if (!storage.isAvailable) {
        throw new Error("力量体系存储仅在 MyAgents 桌面端可用");
      }
      for (const file of createPowerSystemInitializationFiles()) {
        const [info] = await storage.stat([file.path]);
        if (info?.exists && info.kind !== "file") {
          throw new Error(`力量体系核心路径不是文件：${file.path}`);
        }
        if (info?.exists) {
          const previous = await storage.readText(file.path);
          await storage.writeText(file.path, file.content, {
            expectedContent: previous.content,
          });
        } else {
          await storage.createText(file.path, file.content, {
            createParents: true,
          });
        }
      }
      return readLibrary(storage);
    },

    async load() {
      if (!(await repository.isInitialized())) return null;
      return readLibrary(storage);
    },

    async loadSystem(entry) {
      const [recordFile, pageFile] = await Promise.all([
        storage.readText(entry.recordPath),
        storage.readText(entry.pagePath),
      ]);
      const record = parsePowerSystemRecord(
        entry.recordPath,
        recordFile.content,
      );
      if (record.id !== entry.id) {
        throw new Error(`力量体系索引与记录 id 不一致：${entry.id}`);
      }
      return Object.freeze({
        record,
        recordContent: recordFile.content,
        pageContent: pageFile.content,
      });
    },

    async createSystem(library, input) {
      if (library.index.systems.some((entry) => entry.id === input.id)) {
        throw new Error(`力量体系 id 已存在：${input.id}`);
      }
      if (!library.meta.systemTypes.some((type) => type.id === input.typeId)) {
        throw new Error(`力量体系类型不存在：${input.typeId}`);
      }
      const record = createPowerSystemRecord(input);
      const paths = systemPaths(record.id);
      const recordContent = serializePowerSystemFile(record);
      const parsedRecord = parsePowerSystemRecord(
        paths.recordPath,
        recordContent,
      );
      const pageContent = `# ${record.name}\n\n`;
      const created: string[] = [];
      try {
        await storage.createText(paths.recordPath, recordContent, {
          createParents: true,
        });
        created.push(paths.recordPath);
        await storage.createText(paths.pagePath, pageContent, {
          createParents: true,
        });
        created.push(paths.pagePath);
        const nextIndex: PowerSystemIndex = {
          ...library.index,
          systems: [...library.index.systems, toIndexEntry(parsedRecord)],
        };
        const indexFile = await storage.writeText(
          POWER_SYSTEM_PATHS.index,
          serializePowerSystemFile(nextIndex),
          { expectedContent: library.indexContent },
        );
        const nextLibrary = replaceLibrary(library, {
          index: parsePowerSystemIndex(indexFile.content),
          indexContent: indexFile.content,
        });
        return {
          library: nextLibrary,
          system: Object.freeze({
            record: parsedRecord,
            recordContent,
            pageContent,
          }),
        };
      } catch (error) {
        await Promise.all(
          created.map((path) =>
            storage.remove(path, { permanent: true }).catch(() => false),
          ),
        );
        throw error;
      }
    },

    async saveWorkspace(library, system, changes) {
      const hasSystemChanges = changes.record !== undefined;
      if (hasSystemChanges && !system) {
        throw new Error("保存体系记录时缺少已加载的体系快照");
      }
      if (hasSystemChanges && changes.pageContent === undefined) {
        throw new Error("保存体系记录时缺少说明页内容");
      }
      if (changes.record && system && changes.record.id !== system.record.id) {
        throw new Error("力量体系稳定 id 不能修改");
      }

      const parsedRecord = changes.record
        ? parsePowerSystemRecord(
            systemPaths(changes.record.id).recordPath,
            serializePowerSystemFile({
              ...changes.record,
              updatedAt: new Date().toISOString(),
            } satisfies PowerSystemRecord),
          )
        : null;
      const nextIndex: PowerSystemIndex = parsedRecord
        ? {
            ...library.index,
            systems: library.index.systems.map((entry) =>
              entry.id === parsedRecord.id ? toIndexEntry(parsedRecord) : entry,
            ),
          }
        : library.index;
      const indexContent = serializePowerSystemFile(nextIndex);
      const catalogContent = changes.catalog
        ? serializePowerSystemFile(changes.catalog)
        : library.catalogContent;
      const connectionsContent = changes.connections
        ? serializePowerSystemFile(changes.connections)
        : library.connectionsContent;
      const parsedCatalog = changes.catalog
        ? parsePowerCatalog(catalogContent)
        : library.catalog;
      const parsedConnections = changes.connections
        ? parsePowerConnections(connectionsContent)
        : library.connections;
      const candidateLibrary = replaceLibrary(library, {
        index: nextIndex,
        indexContent,
        catalog: parsedCatalog,
        catalogContent,
        connections: parsedConnections,
        connectionsContent,
      });
      await validateLibraryReferences(
        storage,
        candidateLibrary,
        parsedRecord ?? undefined,
      );

      const pendingWrites: {
        readonly path: string;
        readonly previous: string;
        readonly content: string;
      }[] = [];
      if (parsedRecord && system) {
        const paths = systemPaths(parsedRecord.id);
        pendingWrites.push(
          {
            path: paths.recordPath,
            previous: system.recordContent,
            content: serializePowerSystemFile(parsedRecord),
          },
          {
            path: paths.pagePath,
            previous: system.pageContent,
            content: changes.pageContent ?? "",
          },
          {
            path: POWER_SYSTEM_PATHS.index,
            previous: library.indexContent,
            content: indexContent,
          },
        );
      }
      if (changes.catalog) {
        pendingWrites.push({
          path: POWER_SYSTEM_PATHS.catalog,
          previous: library.catalogContent,
          content: catalogContent,
        });
      }
      if (changes.connections) {
        pendingWrites.push({
          path: POWER_SYSTEM_PATHS.connections,
          previous: library.connectionsContent,
          content: connectionsContent,
        });
      }

      const applied: {
        readonly path: string;
        readonly previous: string;
        readonly written: string;
      }[] = [];
      const writtenByPath = new Map<string, string>();
      try {
        for (const write of pendingWrites) {
          const file = await storage.writeText(write.path, write.content, {
            expectedContent: write.previous,
          });
          applied.push({
            path: write.path,
            previous: write.previous,
            written: file.content,
          });
          writtenByPath.set(write.path, file.content);
        }
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const write of [...applied].reverse()) {
          try {
            await storage.writeText(write.path, write.previous, {
              expectedContent: write.written,
            });
          } catch (rollbackError) {
            rollbackErrors.push(
              `${write.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        if (rollbackErrors.length > 0) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}；保存回滚失败：${rollbackErrors.join("；")}`,
          );
        }
        throw error;
      }

      const nextLibrary = replaceLibrary(library, {
        ...(parsedRecord
          ? {
              index: parsePowerSystemIndex(
                writtenByPath.get(POWER_SYSTEM_PATHS.index) ?? indexContent,
              ),
              indexContent:
                writtenByPath.get(POWER_SYSTEM_PATHS.index) ?? indexContent,
            }
          : {}),
        ...(changes.catalog
          ? {
              catalog: parsePowerCatalog(
                writtenByPath.get(POWER_SYSTEM_PATHS.catalog) ?? catalogContent,
              ),
              catalogContent:
                writtenByPath.get(POWER_SYSTEM_PATHS.catalog) ?? catalogContent,
            }
          : {}),
        ...(changes.connections
          ? {
              connections: parsePowerConnections(
                writtenByPath.get(POWER_SYSTEM_PATHS.connections) ??
                  connectionsContent,
              ),
              connectionsContent:
                writtenByPath.get(POWER_SYSTEM_PATHS.connections) ??
                connectionsContent,
            }
          : {}),
      });
      const nextSystem =
        parsedRecord && system
          ? Object.freeze({
              record: parsedRecord,
              recordContent:
                writtenByPath.get(systemPaths(parsedRecord.id).recordPath) ??
                serializePowerSystemFile(parsedRecord),
              pageContent:
                writtenByPath.get(systemPaths(parsedRecord.id).pagePath) ??
                changes.pageContent ??
                "",
            })
          : system;
      return { library: nextLibrary, system: nextSystem };
    },

    async saveSystem(library, system, record, pageContent) {
      const result = await repository.saveWorkspace(library, system, {
        record,
        pageContent,
      });
      if (!result.system) throw new Error("保存后未返回力量体系");
      return { library: result.library, system: result.system };
    },

    async saveCatalog(library, catalog) {
      return (await repository.saveWorkspace(library, null, { catalog }))
        .library;
    },

    async saveConnections(library, connections) {
      return (await repository.saveWorkspace(library, null, { connections }))
        .library;
    },

    async saveLibrary(library, catalog, connections) {
      return (
        await repository.saveWorkspace(library, null, { catalog, connections })
      ).library;
    },
  };
  return repository;
}
