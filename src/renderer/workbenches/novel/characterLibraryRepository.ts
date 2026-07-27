import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

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
  serializeCharacterLibraryFile,
  type CharacterLibraryIndex,
  type CharacterLibraryMeta,
  type CharacterRecord,
} from "./characterLibrarySchema";

export const CHARACTER_LIBRARY_PATHS = Object.freeze({
  index: "characters/index.json",
  meta: "characters/library.json",
});

const CULTIVATION_ECOLOGY_PATH = "world/cultivation-ecology.json";

export interface LoadedCharacterLibrary {
  readonly index: CharacterLibraryIndex;
  readonly indexContent: string;
  readonly meta: CharacterLibraryMeta;
  readonly metaContent: string;
}

export interface NovelCharacterLibraryRepository {
  load(): Promise<LoadedCharacterLibrary>;
  saveCharacters(
    library: LoadedCharacterLibrary,
    characters: readonly CharacterRecord[],
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

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, content, { createParents: true });
  } catch {
    return storage.readText(path);
  }
}

function ensureUniqueReferences(
  characters: readonly CharacterRecord[],
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
    if (character.soulId && !soulIds.has(character.soulId)) {
      throw new Error(`角色“${character.name}”关联了不存在的角色灵魂`);
    }
    for (const groupId of character.groupIds) {
      if (!groupIds.has(groupId)) {
        throw new Error(`角色“${character.name}”关联了不存在的角色分组`);
      }
    }
    for (const relation of character.relations) {
      if (!characterIds.has(relation.targetId)) {
        throw new Error(`角色“${character.name}”的关系指向了不存在的角色`);
      }
    }
  }
}

async function ensureCultivationReferences(
  storage: WorkbenchStorage,
  characters: readonly CharacterRecord[],
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
  characters.forEach((character) => {
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
  });
}

function parseCharacters(
  characters: readonly CharacterRecord[],
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
          ensureTextFile(storage, file.path, file.content),
        ),
      );
      const library: LoadedCharacterLibrary = Object.freeze({
        index: parseCharacterLibraryIndex(indexFile.content),
        indexContent: indexFile.content,
        meta: parseCharacterLibraryMeta(metaFile.content),
        metaContent: metaFile.content,
      });
      ensureUniqueReferences(library.index.characters, library.meta);
      await ensureCultivationReferences(storage, library.index.characters);
      return library;
    },

    async saveCharacters(
      library: LoadedCharacterLibrary,
      characters: readonly CharacterRecord[],
    ) {
      const index = parseCharacters(characters);
      ensureUniqueReferences(index.characters, library.meta);
      await ensureCultivationReferences(storage, index.characters);
      const content = serializeIndex(index);
      const file = await storage.writeText(
        CHARACTER_LIBRARY_PATHS.index,
        content,
        {
          expectedContent: library.indexContent,
        },
      );
      return replaceLibrary(library, {
        index: parseCharacterLibraryIndex(file.content),
        indexContent: file.content,
      });
    },

    async saveMeta(
      library: LoadedCharacterLibrary,
      meta: CharacterLibraryMeta,
    ) {
      const content = serializeMeta(meta);
      const parsedMeta = parseCharacterLibraryMeta(content);
      ensureUniqueReferences(library.index.characters, parsedMeta);
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
