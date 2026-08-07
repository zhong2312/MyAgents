import { describe, expect, it } from "vitest";

import type { CharacterRecord } from "../entities/characterLibrarySchema";

import {
  CHARACTER_LIBRARY_PATHS,
  createNovelCharacterLibraryRepository,
} from "./characterLibraryRepository";
import { createEmptyNovelStorage } from "../../../shared/infrastructure/testStorage";

function character(id: string, name: string): CharacterRecord {
  return {
    id,
    name,
    alias: "",
    roleWeight: "secondary",
    archetype: "",
    alignment: "",
    status: "在世",
    summary: `${name} 的摘要`,
    identities: [],
    age: "20",
    currentRealm: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    cultivationProfile: {
      systemId: null,
      trackId: null,
      levelId: null,
      methodIds: [],
      abilityIds: [],
      resourceBalances: {},
      activeConstraintIds: [],
      breakthroughHistory: [],
    },
    gender: "",
    raceId: "",
    soulId: "",
    groupIds: [],
    hometown: "",
    appearance: "",
    personality: "",
    values: "",
    strengths: "",
    weaknesses: "",
    fears: "",
    motivation: "",
    goals: "",
    innerConflict: "",
    background: "",
    abilities: "",
    speechStyle: "",
    habits: "",
    signatureItem: "",
    storyRole: "",
    arc: "",
    firstAppearance: "",
    completeness: 0,
    relations: [],
    appearances: [],
    arcStages: [],
    inventory: [],
  };
}

describe("NovelCharacterLibraryRepository 分片存储", () => {
  it("load 仅读取 meta 与 index，不扫描 records", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();
    await repository.saveCharacter(library, character("character-a", "甲"));
    let recordReads = 0;
    const readText = storage.readText.bind(storage);
    storage.readText = async (path) => {
      if (path.startsWith(`${CHARACTER_LIBRARY_PATHS.records}/`)) recordReads += 1;
      return readText(path);
    };

    const loaded = await repository.load();

    expect(loaded.index.characters).toHaveLength(1);
    expect(recordReads).toBe(0);
  });

  it("saveCharacter 同时写入 record 与索引摘要", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();

    const saved = await repository.saveCharacter(
      library,
      character("character-a", "甲"),
    );

    expect(storage.getText("characters/records/character-a.json")).toContain(
      '"schemaVersion": 1',
    );
    expect(saved.index.characters).toEqual([
      expect.objectContaining({
        id: "character-a",
        name: "甲",
        recordPath: "characters/records/character-a.json",
      }),
    ]);
    expect(saved.index.characters[0]).not.toHaveProperty("relations");
  });

  it("record 写入失败时索引保持原状", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    let library = await repository.load();
    library = await repository.saveCharacter(library, character("character-a", "甲"));
    const beforeIndex = storage.getText(CHARACTER_LIBRARY_PATHS.index);
    const beforeRecord = storage.getText("characters/records/character-a.json");
    storage.failWritePathOnce = "characters/records/character-a.json";

    await expect(
      repository.saveCharacter(library, character("character-a", "新甲")),
    ).rejects.toThrow("Injected write failure");
    expect(storage.getText(CHARACTER_LIBRARY_PATHS.index)).toBe(beforeIndex);
    expect(storage.getText("characters/records/character-a.json")).toBe(
      beforeRecord,
    );
  });

  it("deleteCharacter 移除索引条目及 record 文件", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    let library = await repository.load();
    library = await repository.saveCharacter(library, character("character-a", "甲"));

    const saved = await repository.deleteCharacter(library, "character-a");

    expect(saved.index.characters).toEqual([]);
    expect(storage.getText("characters/records/character-a.json")).toBeUndefined();
  });

  it("并发保存不同角色时会合并索引更新", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();

    await Promise.all([
      repository.saveCharacter(library, character("character-a", "甲")),
      repository.saveCharacter(library, character("character-b", "乙")),
    ]);

    const loaded = await repository.load();
    expect(loaded.index.characters.map((entry) => entry.id).sort()).toEqual([
      "character-a",
      "character-b",
    ]);
  });
});
