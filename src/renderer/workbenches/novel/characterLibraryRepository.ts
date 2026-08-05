import {
  ensureWorkbenchTextFile,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  cultivationEcologySchema,
  type CultivationEcology,
} from "../../../shared/workbenches/novel/cultivationEcologySchema";

import {
  createDefaultCharacterLibraryMeta,
  createEmptyCharacterLibraryIndex,
} from "./characterLibraryDefaults";
import {
  parseCharacterLibraryIndex,
  parseCharacterLibraryMeta,
  parseCharacterRecordFile,
  serializeCharacterLibraryFile,
  type CharacterIndexEntry,
  type CharacterLibraryIndex,
  type CharacterLibraryMeta,
  type CharacterRecord,
} from "./characterLibrarySchema";
import { createStorageTransaction } from "./storageTransaction";

export const CHARACTER_LIBRARY_PATHS = Object.freeze({
  index: "characters/index.json",
  meta: "characters/library.json",
  records: "characters/records",
});

const CULTIVATION_ECOLOGY_PATH = "world/cultivation-ecology.json";

export interface LoadedCharacterLibrary {
  readonly index: CharacterLibraryIndex;
  readonly indexContent: string;
  readonly meta: CharacterLibraryMeta;
  readonly metaContent: string;
}

export interface LoadedCharacterRecord {
  readonly record: CharacterRecord;
  readonly content: string;
}

export interface NovelCharacterLibraryRepository {
  load(): Promise<LoadedCharacterLibrary>;
  loadCharacter(entry: CharacterIndexEntry): Promise<LoadedCharacterRecord>;
  saveCharacter(
    library: LoadedCharacterLibrary,
    character: CharacterRecord,
  ): Promise<LoadedCharacterLibrary>;
  deleteCharacter(
    library: LoadedCharacterLibrary,
    id: string,
  ): Promise<LoadedCharacterLibrary>;
  saveMeta(
    library: LoadedCharacterLibrary,
    meta: CharacterLibraryMeta,
  ): Promise<LoadedCharacterLibrary>;
}

function serializeIndex(index: CharacterLibraryIndex): string {
  return serializeCharacterLibraryFile(index);
}

function serializeMeta(meta: CharacterLibraryMeta): string {
  return serializeCharacterLibraryFile(meta);
}

function replaceLibrary(
  library: LoadedCharacterLibrary,
  patch: Partial<LoadedCharacterLibrary>,
): LoadedCharacterLibrary {
  return Object.freeze({ ...library, ...patch });
}

function ensureUniqueReferences(
  characters: readonly CharacterIndexEntry[],
  currentCharacter: CharacterRecord | null,
  meta: CharacterLibraryMeta,
): void {
  const raceIds = new Set(meta.races.map((race) => race.id));
  const groupIds = new Set(meta.groups.map((group) => group.id));
  const soulIds = new Set(meta.souls.map((soul) => soul.id));
  const characterIds = new Set(characters.map((character) => character.id));

  for (const character of characters) {
    if (character.raceId && !raceIds.has(character.raceId)) {
      throw new Error(`角色“${character.name}”关联了不存在的种族`);
    }
    for (const groupId of character.groupIds) {
      if (!groupIds.has(groupId)) {
        throw new Error(`角色“${character.name}”关联了不存在的角色分组`);
      }
    }
  }
  if (!currentCharacter) return;
  characterIds.add(currentCharacter.id);
  if (currentCharacter.raceId && !raceIds.has(currentCharacter.raceId)) {
    throw new Error(`角色“${currentCharacter.name}”关联了不存在的种族`);
  }
  if (currentCharacter.soulId && !soulIds.has(currentCharacter.soulId)) {
    throw new Error(`角色“${currentCharacter.name}”关联了不存在的角色灵魂`);
  }
  for (const groupId of currentCharacter.groupIds) {
    if (!groupIds.has(groupId)) {
      throw new Error(`角色“${currentCharacter.name}”关联了不存在的角色分组`);
    }
  }
  for (const relation of currentCharacter.relations) {
    if (!characterIds.has(relation.targetId)) {
      throw new Error(`角色“${currentCharacter.name}”的关系指向了不存在的角色`);
    }
  }
}

async function ensureCultivationReferences(
  storage: WorkbenchStorage,
  character: CharacterRecord,
): Promise<void> {
  const [entry] = await storage.stat([CULTIVATION_ECOLOGY_PATH]);
  if (!entry?.exists) return;
  const file = await storage.readText(CULTIVATION_ECOLOGY_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    throw new Error("修行生态数据无法解析，暂不能保存角色修行引用。");
  }
  const result = cultivationEcologySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("修行生态数据格式无效，暂不能保存角色修行引用。");
  }
  const ecology: CultivationEcology = result.data;
  const systems = new Map(ecology.systems.map((system) => [system.id, system]));
  const tracks = new Map(
    ecology.systems.flatMap((system) =>
      system.progressionTracks.map(
        (track) => [track.id, { system, track }] as const,
      ),
    ),
  );
  const levels = new Map(
    ecology.systems.flatMap((system) =>
      system.progressionTracks.flatMap((track) =>
        track.levels.map(
          (level) => [level.id, { system, track, level }] as const,
        ),
      ),
    ),
  );
  const methods = new Map(
    ecology.systems.flatMap((system) =>
      system.methods.map((method) => [method.id, system] as const),
    ),
  );
  const abilities = new Map(
    ecology.systems.flatMap((system) =>
      system.abilities.map((ability) => [ability.id, system] as const),
    ),
  );
  const constraints = new Map(
    ecology.systems.flatMap((system) =>
      system.constraints.map((constraint) => [constraint.id, system] as const),
    ),
  );
  const resources = new Map(
    ecology.systems.flatMap((system) =>
      system.resources.map((resource) => [resource.id, system] as const),
    ),
  );
  const transitions = new Map(
    ecology.systems.flatMap((system) => [
      ...system.transitions.map(
        (transition) => [transition.id, system] as const,
      ),
      ...system.progressionTracks.flatMap((track) =>
        track.transitions.map((transition) => [transition.id, system] as const),
      ),
    ]),
  );
  const check = (
    character: CharacterRecord,
    id: string,
    label: string,
    index: Map<string, CultivationEcology["systems"][number]>,
  ) => {
    if (!index.has(id))
      throw new Error(
        `角色“${character.name}”的${label}引用了不存在的修行资产 ${id}`,
      );
  };
  {
    const profile = character.cultivationProfile;
    if (!profile) return;
    const hasBoundAssets =
      Boolean(profile.trackId || profile.levelId) ||
      profile.methodIds.length > 0 ||
      profile.abilityIds.length > 0 ||
      Object.keys(profile.resourceBalances).length > 0 ||
      profile.activeConstraintIds.length > 0 ||
      profile.breakthroughHistory.length > 0;
    if (!profile.systemId && hasBoundAssets)
      throw new Error(
        `角色“${character.name}”的修行档案存在资产，但未绑定修行体系`,
      );
    if (profile.systemId)
      check(character, profile.systemId, "修行体系", systems);
    if (profile.trackId && !tracks.has(profile.trackId))
      throw new Error(
        `角色“${character.name}”的成长轨道引用了不存在的修行资产 ${profile.trackId}`,
      );
    if (profile.levelId && !levels.has(profile.levelId))
      throw new Error(
        `角色“${character.name}”的当前阶段引用了不存在的修行资产 ${profile.levelId}`,
      );
    profile.methodIds.forEach((id) => check(character, id, "法门", methods));
    profile.abilityIds.forEach((id) => check(character, id, "能力", abilities));
    profile.activeConstraintIds.forEach((id) =>
      check(character, id, "活跃约束", constraints),
    );
    Object.keys(profile.resourceBalances).forEach((id) =>
      check(character, id, "内部资源", resources),
    );
    profile.breakthroughHistory.forEach((entry) =>
      check(character, entry.transitionId, "突破记录", transitions),
    );
    if (
      profile.systemId &&
      profile.trackId &&
      tracks.get(profile.trackId)?.system.id !== profile.systemId
    )
      throw new Error(`角色“${character.name}”的成长轨道不属于所选修行体系`);
    if (
      profile.trackId &&
      profile.levelId &&
      levels.get(profile.levelId)?.track.id !== profile.trackId
    )
      throw new Error(`角色“${character.name}”的当前阶段不属于所选成长轨道`);
    if (profile.systemId) {
      const system = systems.get(profile.systemId);
      const belongsToSystem = (
        index: Map<string, CultivationEcology["systems"][number]>,
        id: string,
      ) => index.get(id)?.id === system?.id;
      const foreignMethod = profile.methodIds.find(
        (id) => !belongsToSystem(methods, id),
      );
      if (foreignMethod)
        throw new Error(`角色“${character.name}”的法门不属于所选修行体系`);
      const foreignAbility = profile.abilityIds.find(
        (id) => !belongsToSystem(abilities, id),
      );
      if (foreignAbility)
        throw new Error(`角色“${character.name}”的能力不属于所选修行体系`);
      const foreignConstraint = profile.activeConstraintIds.find(
        (id) => !belongsToSystem(constraints, id),
      );
      if (foreignConstraint)
        throw new Error(`角色“${character.name}”的活跃约束不属于所选修行体系`);
      const foreignResource = Object.keys(profile.resourceBalances).find(
        (id) => !belongsToSystem(resources, id),
      );
      if (foreignResource)
        throw new Error(`角色“${character.name}”的内部资源不属于所选修行体系`);
      const foreignTransition = profile.breakthroughHistory.find(
        (entry) => !belongsToSystem(transitions, entry.transitionId),
      );
      if (foreignTransition)
        throw new Error(`角色“${character.name}”的突破记录不属于所选修行体系`);
    }
  }
}

function characterRecordPath(id: string): string {
  return `${CHARACTER_LIBRARY_PATHS.records}/${id}.json`;
}

function asCharacterRecord(
  record: ReturnType<typeof parseCharacterRecordFile>,
): CharacterRecord {
  const { schemaVersion: _schemaVersion, ...character } = record;
  return character;
}

function serializeRecord(record: CharacterRecord): string {
  return serializeCharacterLibraryFile({
    schemaVersion: createEmptyCharacterLibraryIndex().schemaVersion,
    ...record,
  });
}

function toIndexEntry(
  record: CharacterRecord,
  updatedAt: string,
): CharacterIndexEntry {
  return {
    id: record.id,
    name: record.name.trim(),
    raceId: record.raceId || null,
    groupIds: [...record.groupIds],
    summary: record.summary,
    recordPath: characterRecordPath(record.id),
    updatedAt,
  };
}

function parseIndex(
  characters: readonly CharacterIndexEntry[],
): CharacterLibraryIndex {
  return parseCharacterLibraryIndex(
    serializeIndex({
      schemaVersion: createEmptyCharacterLibraryIndex().schemaVersion,
      characters: [...characters],
    }),
  );
}

export function createCharacterLibraryInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: CHARACTER_LIBRARY_PATHS.index,
      content: serializeIndex(createEmptyCharacterLibraryIndex()),
    },
    {
      path: CHARACTER_LIBRARY_PATHS.meta,
      content: serializeMeta(createDefaultCharacterLibraryMeta()),
    },
  ];
}

export function createNovelCharacterLibraryRepository(
  storage: WorkbenchStorage,
): NovelCharacterLibraryRepository {
  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("人物库存储仅在 MyAgents 桌面端可用");
      }
      const initialFiles = createCharacterLibraryInitializationFiles();
      const [indexFile, metaFile] = await Promise.all(
        initialFiles.map((file) =>
          ensureWorkbenchTextFile(storage, file.path, file.content),
        ),
      );
      const library: LoadedCharacterLibrary = Object.freeze({
        index: parseCharacterLibraryIndex(indexFile.content),
        indexContent: indexFile.content,
        meta: parseCharacterLibraryMeta(metaFile.content),
        metaContent: metaFile.content,
      });
      ensureUniqueReferences(library.index.characters, null, library.meta);
      return library;
    },

    async loadCharacter(entry: CharacterIndexEntry) {
      const file = await storage.readText(entry.recordPath);
      const record = asCharacterRecord(
        parseCharacterRecordFile(entry.recordPath, file.content),
      );
      if (record.id !== entry.id) {
        throw new Error(`人物索引与记录 id 不一致：${entry.id}`);
      }
      return Object.freeze({ record, content: file.content });
    },

    async saveCharacter(
      library: LoadedCharacterLibrary,
      character: CharacterRecord,
    ) {
      const recordPath = characterRecordPath(character.id);
      const recordContent = serializeRecord(character);
      const parsedRecord = asCharacterRecord(
        parseCharacterRecordFile(recordPath, recordContent),
      );
      await ensureCultivationReferences(storage, parsedRecord);

      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const [indexFile, recordInfo] = await Promise.all([
          storage.readText(CHARACTER_LIBRARY_PATHS.index),
          storage.stat([recordPath]),
        ]);
        const index = parseCharacterLibraryIndex(indexFile.content);
        ensureUniqueReferences(index.characters, parsedRecord, library.meta);
        const updatedAt = new Date().toISOString();
        const nextIndex = parseIndex(
          index.characters.some((entry) => entry.id === parsedRecord.id)
            ? index.characters.map((entry) =>
                entry.id === parsedRecord.id
                  ? toIndexEntry(parsedRecord, updatedAt)
                  : entry,
              )
            : [...index.characters, toIndexEntry(parsedRecord, updatedAt)],
        );
        const transaction = createStorageTransaction(storage);
        if (recordInfo[0]?.exists) {
          const currentRecord = await storage.readText(recordPath);
          transaction.writeText(
            recordPath,
            recordContent,
            currentRecord.content,
          );
        } else {
          transaction.createText(recordPath, recordContent);
        }
        const nextIndexContent = serializeIndex(nextIndex);
        transaction.writeText(
          CHARACTER_LIBRARY_PATHS.index,
          nextIndexContent,
          indexFile.content,
        );
        try {
          await transaction.commit();
          return replaceLibrary(library, {
            index: nextIndex,
            indexContent: nextIndexContent,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "File changed externally"
          ) {
            throw error;
          }
          lastError = error;
        }
      }
      throw lastError;
    },

    async deleteCharacter(library: LoadedCharacterLibrary, id: string) {
      const indexFile = await storage.readText(CHARACTER_LIBRARY_PATHS.index);
      const index = parseCharacterLibraryIndex(indexFile.content);
      const entry = index.characters.find((character) => character.id === id);
      if (!entry) throw new Error(`角色不存在：${id}`);
      const nextIndex = parseIndex(
        index.characters.filter((character) => character.id !== id),
      );
      const nextIndexContent = serializeIndex(nextIndex);
      await storage.writeText(CHARACTER_LIBRARY_PATHS.index, nextIndexContent, {
        expectedContent: indexFile.content,
      });
      const removed = await storage.remove(entry.recordPath, {
        permanent: true,
      });
      if (!removed) throw new Error(`角色记录删除失败：${entry.recordPath}`);
      return replaceLibrary(library, {
        index: nextIndex,
        indexContent: nextIndexContent,
      });
    },

    async saveMeta(
      library: LoadedCharacterLibrary,
      meta: CharacterLibraryMeta,
    ) {
      const content = serializeMeta(meta);
      const parsedMeta = parseCharacterLibraryMeta(content);
      ensureUniqueReferences(library.index.characters, null, parsedMeta);
      const file = await storage.writeText(
        CHARACTER_LIBRARY_PATHS.meta,
        content,
        {
          expectedContent: library.metaContent,
        },
      );
      return replaceLibrary(library, {
        meta: parseCharacterLibraryMeta(file.content),
        metaContent: file.content,
      });
    },
  });
}

/** 仅由需要详情字段的调用方显式触发全量 record 读取。 */
export async function loadCharacterRecords(
  repository: NovelCharacterLibraryRepository,
  library: LoadedCharacterLibrary,
): Promise<readonly CharacterRecord[]> {
  const records = await Promise.all(
    library.index.characters.map(async (entry) =>
      (await repository.loadCharacter(entry)).record,
    ),
  );
  return Object.freeze(records);
}
