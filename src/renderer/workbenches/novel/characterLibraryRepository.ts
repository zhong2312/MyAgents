import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

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
      return library;
    },

    async saveCharacters(
      library: LoadedCharacterLibrary,
      characters: readonly CharacterRecord[],
    ) {
      const index = parseCharacters(characters);
      ensureUniqueReferences(index.characters, library.meta);
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
