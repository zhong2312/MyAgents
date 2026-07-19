import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createDefaultPowerSystemMeta,
  createEmptyPowerSystemIndex,
  createEmptyPowerSystemInteractions,
  createPowerSystemRecord,
} from "./powerSystemDefaults";
import {
  parsePowerSystemIndex,
  parsePowerSystemInteractions,
  parsePowerSystemMeta,
  parsePowerSystemRecord,
  serializePowerSystemFile,
  type PowerSystemIndex,
  type PowerSystemIndexEntry,
  type PowerSystemInteractions,
  type PowerSystemMeta,
  type PowerSystemRecord,
} from "./powerSystemSchema";

export const POWER_SYSTEM_PATHS = Object.freeze({
  root: "world/power-systems",
  meta: "world/power-systems/meta.json",
  index: "world/power-systems/index.json",
  interactions: "world/power-systems/interactions.json",
  records: "world/power-systems/records",
  pages: "world/power-systems/pages",
  proposals: "world/power-systems/proposals",
});

export interface LoadedPowerSystemLibrary {
  readonly meta: PowerSystemMeta;
  readonly metaContent: string;
  readonly index: PowerSystemIndex;
  readonly indexContent: string;
  readonly interactions: PowerSystemInteractions;
  readonly interactionsContent: string;
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
  saveInteractions(
    library: LoadedPowerSystemLibrary,
    interactions: PowerSystemInteractions,
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
      path: POWER_SYSTEM_PATHS.interactions,
      content: serializePowerSystemFile(createEmptyPowerSystemInteractions()),
    },
  ];
}

function validateLibrary(library: LoadedPowerSystemLibrary) {
  const typeIds = new Set(library.meta.systemTypes.map((type) => type.id));
  const systemIds = new Set<string>();
  library.index.systems.forEach((entry) => {
    if (systemIds.has(entry.id))
      throw new Error(`力量体系 id 重复：${entry.id}`);
    systemIds.add(entry.id);
    if (!typeIds.has(entry.typeId)) {
      throw new Error(`力量体系“${entry.name}”引用了不存在的体系类型`);
    }
  });
  library.interactions.interactions.forEach((interaction) => {
    if (
      !systemIds.has(interaction.left.systemId) ||
      !systemIds.has(interaction.right.systemId)
    ) {
      throw new Error(`跨体系交互“${interaction.name}”引用了不存在的力量体系`);
    }
    for (const reference of [interaction.left, interaction.right]) {
      if (
        reference.kind === "system" &&
        reference.targetId !== reference.systemId
      ) {
        throw new Error(
          `跨体系交互“${interaction.name}”的体系级引用 id 不一致`,
        );
      }
    }
  });
}

async function readLibrary(
  storage: WorkbenchStorage,
): Promise<LoadedPowerSystemLibrary> {
  const [metaFile, indexFile, interactionsFile] = await Promise.all([
    storage.readText(POWER_SYSTEM_PATHS.meta),
    storage.readText(POWER_SYSTEM_PATHS.index),
    storage.readText(POWER_SYSTEM_PATHS.interactions),
  ]);
  const library: LoadedPowerSystemLibrary = Object.freeze({
    meta: parsePowerSystemMeta(metaFile.content),
    metaContent: metaFile.content,
    index: parsePowerSystemIndex(indexFile.content),
    indexContent: indexFile.content,
    interactions: parsePowerSystemInteractions(interactionsFile.content),
    interactionsContent: interactionsFile.content,
  });
  validateLibrary(library);
  return library;
}

async function rollbackWrite(
  storage: WorkbenchStorage,
  path: string,
  previous: string,
  expected: string,
) {
  await storage
    .writeText(path, previous, { expectedContent: expected })
    .catch(() => null);
}

export function createNovelPowerSystemRepository(
  storage: WorkbenchStorage,
): NovelPowerSystemRepository {
  const repository: NovelPowerSystemRepository = {
    async isInitialized() {
      const entries = await storage.stat([
        POWER_SYSTEM_PATHS.meta,
        POWER_SYSTEM_PATHS.index,
        POWER_SYSTEM_PATHS.interactions,
      ]);
      return entries.every((entry) => entry.exists && entry.kind === "file");
    },

    async initialize() {
      if (!storage.isAvailable) {
        throw new Error("力量体系存储仅在 MyAgents 桌面端可用");
      }
      for (const file of createPowerSystemInitializationFiles()) {
        const [info] = await storage.stat([file.path]);
        if (!info?.exists) {
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
        const indexContent = serializePowerSystemFile(nextIndex);
        const indexFile = await storage.writeText(
          POWER_SYSTEM_PATHS.index,
          indexContent,
          {
            expectedContent: library.indexContent,
          },
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

    async saveSystem(library, system, record, pageContent) {
      if (record.id !== system.record.id)
        throw new Error("力量体系稳定 id 不能修改");
      const now = new Date().toISOString();
      const candidate = {
        ...record,
        updatedAt: now,
      } satisfies PowerSystemRecord;
      const paths = systemPaths(candidate.id);
      const recordContent = serializePowerSystemFile(candidate);
      const parsedRecord = parsePowerSystemRecord(
        paths.recordPath,
        recordContent,
      );
      const nextIndex: PowerSystemIndex = {
        ...library.index,
        systems: library.index.systems.map((entry) =>
          entry.id === parsedRecord.id ? toIndexEntry(parsedRecord) : entry,
        ),
      };
      const indexContent = serializePowerSystemFile(nextIndex);
      let writtenRecord: string | null = null;
      let writtenPage: string | null = null;
      try {
        const recordFile = await storage.writeText(
          paths.recordPath,
          recordContent,
          {
            expectedContent: system.recordContent,
          },
        );
        writtenRecord = recordFile.content;
        const pageFile = await storage.writeText(paths.pagePath, pageContent, {
          expectedContent: system.pageContent,
        });
        writtenPage = pageFile.content;
        const indexFile = await storage.writeText(
          POWER_SYSTEM_PATHS.index,
          indexContent,
          {
            expectedContent: library.indexContent,
          },
        );
        return {
          library: replaceLibrary(library, {
            index: parsePowerSystemIndex(indexFile.content),
            indexContent: indexFile.content,
          }),
          system: Object.freeze({
            record: parsedRecord,
            recordContent: recordFile.content,
            pageContent: pageFile.content,
          }),
        };
      } catch (error) {
        if (writtenPage !== null) {
          await rollbackWrite(
            storage,
            paths.pagePath,
            system.pageContent,
            writtenPage,
          );
        }
        if (writtenRecord !== null) {
          await rollbackWrite(
            storage,
            paths.recordPath,
            system.recordContent,
            writtenRecord,
          );
        }
        throw error;
      }
    },

    async saveInteractions(library, interactions) {
      const content = serializePowerSystemFile(interactions);
      const parsed = parsePowerSystemInteractions(content);
      const candidate = replaceLibrary(library, { interactions: parsed });
      validateLibrary(candidate);
      const file = await storage.writeText(
        POWER_SYSTEM_PATHS.interactions,
        content,
        {
          expectedContent: library.interactionsContent,
        },
      );
      return replaceLibrary(library, {
        interactions: parsePowerSystemInteractions(file.content),
        interactionsContent: file.content,
      });
    },
  };
  return repository;
}
