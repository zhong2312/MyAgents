import type { WorkbenchStorage } from "@/workbench-sdk";

import type { CultivationEcology } from "../../../../../../shared/workbenches/novel/cultivationEcologySchema";
import {
  CULTIVATION_ECOLOGY_INDEX_PATH,
  loadCultivationEcologyFiles,
} from "../../../../../../shared/workbenches/novel/cultivationEcologyStorage";
import {
  CHARACTER_SOUL_INDEX_PATH,
  CHARACTER_SOUL_RECORDS_DIRECTORY,
  characterSoulFileMap,
  createCharacterSoulFiles,
  loadCharacterSoulFiles,
  serializeCharacterSoulSnapshot,
} from "../../../../../../shared/workbenches/novel/characterSoulStorage";

import {
  createDefaultCharacterLibraryMeta,
  createEmptyCharacterLibraryIndex,
} from "../business/characterLibraryDefaults";
import {
  parseCharacterLibraryIndex,
  parseCharacterLibraryMeta,
  parseCharacterLibraryMetaFile,
  parseCharacterRecordFile,
  serializeCharacterLibraryFile,
  type CharacterIndexEntry,
  type CharacterLibraryIndex,
  type CharacterLibraryMeta,
  type CharacterLibraryMetaFile,
  type CharacterRecord,
} from "../entities/characterLibrarySchema";
import { createStorageTransaction } from "../../../shared/infrastructure/storageTransaction";

export const CHARACTER_LIBRARY_PATHS = Object.freeze({
  index: "characters/index.json",
  meta: "characters/library.json",
  records: "characters/records",
  soulIndex: CHARACTER_SOUL_INDEX_PATH,
  soulRecords: CHARACTER_SOUL_RECORDS_DIRECTORY,
});

export interface LoadedCharacterLibrary {
  readonly index: CharacterLibraryIndex;
  readonly indexContent: string;
  readonly meta: CharacterLibraryMeta;
  readonly metaContent: string;
  /** 已读取的完整角色灵魂目录快照，用于保存时的 CAS。 */
  readonly soulContent: string;
  readonly soulFiles: ReadonlyMap<string, string>;
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
  saveCharacters(
    library: LoadedCharacterLibrary,
    characters: readonly CharacterRecord[],
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

function serializeMeta(meta: CharacterLibraryMetaFile): string {
  return serializeCharacterLibraryFile(meta);
}

function metaFileFromAggregate(
  meta: CharacterLibraryMeta,
): CharacterLibraryMetaFile {
  const { souls: _souls, ...file } = meta;
  return parseCharacterLibraryMetaFile(serializeMeta(file));
}

function aggregateMeta(
  meta: CharacterLibraryMetaFile,
  souls: Readonly<CharacterLibraryMeta["souls"]>,
): CharacterLibraryMeta {
  return parseCharacterLibraryMeta(
    serializeCharacterLibraryFile({ ...meta, souls: [...souls] }),
  );
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
      throw new Error(
        `角色“${currentCharacter.name}”的关系指向了不存在的角色：${relation.targetId}`,
      );
    }
  }
}

export function validateCharacterLibraryReferences(
  meta: CharacterLibraryMeta,
  characters: readonly CharacterRecord[],
): void {
  const characterIds = new Set<string>();
  for (const character of characters) {
    if (characterIds.has(character.id)) {
      throw new Error(`角色 id 不得重复：${character.id}`);
    }
    characterIds.add(character.id);
  }
  const entries = characters.map((character) =>
    toIndexEntry(character, "1970-01-01T00:00:00.000Z"),
  );
  for (const character of characters) {
    ensureUniqueReferences(entries, character, meta);
  }
}

async function ensureCultivationReferences(
  storage: WorkbenchStorage,
  character: CharacterRecord,
): Promise<void> {
  const [entry] = await storage.stat([CULTIVATION_ECOLOGY_INDEX_PATH]);
  if (!entry?.exists) return;
  let ecology: CultivationEcology;
  try {
    ecology = (
      await loadCultivationEcologyFiles(
        async (path) => (await storage.readText(path)).content,
      )
    ).ecology;
  } catch {
    throw new Error("修行生态数据无法解析，暂不能保存角色修行引用。");
  }
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
  const defaults = createDefaultCharacterLibraryMeta();
  return [
    {
      path: CHARACTER_LIBRARY_PATHS.index,
      content: serializeIndex(createEmptyCharacterLibraryIndex()),
    },
    {
      path: CHARACTER_LIBRARY_PATHS.meta,
      content: serializeMeta(metaFileFromAggregate(defaults)),
    },
    ...createCharacterSoulFiles(defaults.souls),
  ];
}

async function loadLibraryFiles(
  storage: WorkbenchStorage,
): Promise<LoadedCharacterLibrary> {
  const [indexFile, metaFile, soulFiles] = await Promise.all([
    storage.readText(CHARACTER_LIBRARY_PATHS.index),
    storage.readText(CHARACTER_LIBRARY_PATHS.meta),
    loadCharacterSoulFiles(
      async (path) => (await storage.readText(path)).content,
    ),
  ]);
  const meta = aggregateMeta(
    parseCharacterLibraryMetaFile(metaFile.content),
    soulFiles.souls,
  );
  const library: LoadedCharacterLibrary = Object.freeze({
    index: parseCharacterLibraryIndex(indexFile.content),
    indexContent: indexFile.content,
    meta,
    metaContent: metaFile.content,
    soulContent: serializeCharacterSoulSnapshot(soulFiles.files),
    soulFiles: soulFiles.files,
  });
  ensureUniqueReferences(library.index.characters, null, library.meta);
  return library;
}

export function createNovelCharacterLibraryRepository(
  storage: WorkbenchStorage,
): NovelCharacterLibraryRepository {
  const saveCharacters = async (
    library: LoadedCharacterLibrary,
    characters: readonly CharacterRecord[],
  ): Promise<LoadedCharacterLibrary> => {
    if (characters.length === 0) return library;
    const parsedCharacters = characters.map((character) => {
      const recordPath = characterRecordPath(character.id);
      return asCharacterRecord(
        parseCharacterRecordFile(recordPath, serializeRecord(character)),
      );
    });
    const candidateIds = new Set<string>();
    for (const character of parsedCharacters) {
      if (candidateIds.has(character.id)) {
        throw new Error(`批量保存的角色 id 不得重复：${character.id}`);
      }
      candidateIds.add(character.id);
    }
    await Promise.all(
      parsedCharacters.map((character) =>
        ensureCultivationReferences(storage, character),
      ),
    );

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recordPaths = parsedCharacters.map((character) =>
        characterRecordPath(character.id),
      );
      const [indexFile, recordInfos] = await Promise.all([
        storage.readText(CHARACTER_LIBRARY_PATHS.index),
        storage.stat(recordPaths),
      ]);
      const currentRecordContents = await Promise.all(
        recordInfos.map(async (info, index) =>
          info?.exists
            ? (await storage.readText(recordPaths[index]!)).content
            : null,
        ),
      );
      const index = parseCharacterLibraryIndex(indexFile.content);
      const recordsById = new Map(
        parsedCharacters.map((character) => [character.id, character]),
      );
      const updatedAt = new Date().toISOString();
      const nextEntries = index.characters.map((entry) => {
        const character = recordsById.get(entry.id);
        return character ? toIndexEntry(character, updatedAt) : entry;
      });
      for (const character of parsedCharacters) {
        if (!index.characters.some((entry) => entry.id === character.id)) {
          nextEntries.push(toIndexEntry(character, updatedAt));
        }
      }
      const nextIndex = parseIndex(nextEntries);
      for (const character of parsedCharacters) {
        ensureUniqueReferences(nextIndex.characters, character, library.meta);
      }

      const transaction = createStorageTransaction(storage);
      parsedCharacters.forEach((character, index) => {
        const path = recordPaths[index]!;
        const content = serializeRecord(character);
        const currentContent = currentRecordContents[index];
        if (currentContent === null) transaction.createText(path, content);
        else transaction.writeText(path, content, currentContent);
      });
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
  };

  return Object.freeze({
    async load() {
      if (!storage.isAvailable) {
        throw new Error("人物库存储仅在 MyAgents 桌面端可用");
      }
      const requiredPaths = [
        CHARACTER_LIBRARY_PATHS.index,
        CHARACTER_LIBRARY_PATHS.meta,
        CHARACTER_LIBRARY_PATHS.soulIndex,
      ];
      const statuses = await storage.stat(requiredPaths);
      if (statuses.every((entry) => !entry.exists)) {
        const transaction = createStorageTransaction(storage);
        for (const file of createCharacterLibraryInitializationFiles()) {
          transaction.createText(file.path, file.content);
        }
        await transaction.commit();
      } else {
        const missing = statuses
          .filter((entry) => !entry.exists)
          .map((entry) => entry.path);
        if (missing.length > 0) {
          throw new Error(
            `人物库目录结构不完整，缺少 ${missing.join("、")}；旧内嵌灵魂数据不兼容且不迁移`,
          );
        }
        const invalid = statuses.find((entry) => entry.kind !== "file");
        if (invalid) throw new Error(`${invalid.path} 不是文件`);
      }
      return loadLibraryFiles(storage);
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
      return saveCharacters(library, [character]);
    },

    saveCharacters,

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
      const parsedMeta = parseCharacterLibraryMeta(
        serializeCharacterLibraryFile(meta),
      );
      ensureUniqueReferences(library.index.characters, null, parsedMeta);
      const [onDiskMeta, onDiskSouls] = await Promise.all([
        storage.readText(CHARACTER_LIBRARY_PATHS.meta),
        loadCharacterSoulFiles(
          async (path) => (await storage.readText(path)).content,
        ),
      ]);
      const onDiskSoulContent = serializeCharacterSoulSnapshot(
        onDiskSouls.files,
      );
      if (
        onDiskMeta.content !== library.metaContent ||
        onDiskSoulContent !== library.soulContent
      ) {
        throw new Error(
          "人物库元数据或角色灵魂已被外部修改，请重新加载后再保存",
        );
      }

      const nextMetaContent = serializeMeta(metaFileFromAggregate(parsedMeta));
      const nextSoulFiles = characterSoulFileMap(
        createCharacterSoulFiles(parsedMeta.souls),
      );
      const transaction = createStorageTransaction(storage);
      const recordPaths = [...nextSoulFiles.keys()]
        .filter((path) => path !== CHARACTER_SOUL_INDEX_PATH)
        .sort((left, right) => left.localeCompare(right));
      for (const path of recordPaths) {
        const content = nextSoulFiles.get(path);
        if (content === undefined) continue;
        const previous = onDiskSouls.files.get(path);
        if (previous === content) continue;
        if (previous === undefined) transaction.createText(path, content);
        else transaction.writeText(path, content, previous);
      }
      if (nextMetaContent !== onDiskMeta.content) {
        transaction.writeText(
          CHARACTER_LIBRARY_PATHS.meta,
          nextMetaContent,
          onDiskMeta.content,
        );
      }
      const nextSoulIndex = nextSoulFiles.get(CHARACTER_SOUL_INDEX_PATH);
      const previousSoulIndex = onDiskSouls.files.get(
        CHARACTER_SOUL_INDEX_PATH,
      );
      if (nextSoulIndex === undefined || previousSoulIndex === undefined) {
        throw new Error("角色灵魂索引快照不完整");
      }
      if (nextSoulIndex !== previousSoulIndex) {
        transaction.writeText(
          CHARACTER_SOUL_INDEX_PATH,
          nextSoulIndex,
          previousSoulIndex,
        );
      }
      await transaction.commit();

      const removedPaths = [...onDiskSouls.files.keys()].filter(
        (path) =>
          path !== CHARACTER_SOUL_INDEX_PATH && !nextSoulFiles.has(path),
      );
      await Promise.allSettled(
        removedPaths.map((path) => storage.remove(path, { permanent: true })),
      );
      return loadLibraryFiles(storage);
    },
  });
}

/** 仅由需要详情字段的调用方显式触发全量 record 读取。 */
export async function loadCharacterRecords(
  repository: NovelCharacterLibraryRepository,
  library: LoadedCharacterLibrary,
): Promise<readonly CharacterRecord[]> {
  const records = await Promise.all(
    library.index.characters.map(
      async (entry) => (await repository.loadCharacter(entry)).record,
    ),
  );
  return Object.freeze(records);
}
