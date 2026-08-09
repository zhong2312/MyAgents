import { describe, expect, it } from "vitest";

import type { CharacterRecord } from "../entities/characterLibrarySchema";
import { createDefaultCharacterLibraryMeta } from "../business/characterLibraryDefaults";
import {
  CHARACTER_SOUL_INDEX_PATH,
  characterSoulRecordPath,
} from "../../../../../../shared/workbenches/novel/characterSoulStorage";

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
  it("初始化时将角色灵魂写入独立索引与记录", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);

    const library = await repository.load();
    const meta = JSON.parse(
      storage.getText(CHARACTER_LIBRARY_PATHS.meta) ?? "{}",
    ) as Record<string, unknown>;

    expect(meta).not.toHaveProperty("souls");
    expect(library.meta.souls.length).toBeGreaterThan(0);
    expect(storage.getText(CHARACTER_SOUL_INDEX_PATH)).toContain('"entries"');
    expect(
      storage.getText(characterSoulRecordPath(library.meta.souls[0]!.id)),
    ).toContain('"mentalModel"');
  });

  it("load 仅读取 meta 与 index，不扫描 records", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();
    await repository.saveCharacter(library, character("character-a", "甲"));
    let recordReads = 0;
    const readText = storage.readText.bind(storage);
    storage.readText = async (path) => {
      if (path.startsWith(`${CHARACTER_LIBRARY_PATHS.records}/`))
        recordReads += 1;
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
    library = await repository.saveCharacter(
      library,
      character("character-a", "甲"),
    );
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
    library = await repository.saveCharacter(
      library,
      character("character-a", "甲"),
    );

    const saved = await repository.deleteCharacter(library, "character-a");

    expect(saved.index.characters).toEqual([]);
    expect(
      storage.getText("characters/records/character-a.json"),
    ).toBeUndefined();
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

  it("只修改灵魂正文时仅改写对应 record", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();
    const target = library.meta.souls[0]!;
    const writes: string[] = [];
    const writeText = storage.writeText.bind(storage);
    storage.writeText = async (path, content, options) => {
      writes.push(path);
      return writeText(path, content, options);
    };

    const saved = await repository.saveMeta(library, {
      ...library.meta,
      souls: library.meta.souls.map((soul) =>
        soul.id === target.id
          ? { ...soul, mentalModel: "更新后的思考模型" }
          : soul,
      ),
    });

    expect(writes).toEqual([characterSoulRecordPath(target.id)]);
    expect(
      saved.meta.souls.find((soul) => soul.id === target.id)?.mentalModel,
    ).toBe("更新后的思考模型");
  });

  it("角色灵魂记录被外部修改后拒绝覆盖", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();
    const target = library.meta.souls[0]!;
    const path = characterSoulRecordPath(target.id);
    const external = JSON.parse(storage.getText(path) ?? "{}") as Record<
      string,
      unknown
    >;
    external.mentalModel = "外部修改";
    storage.setExternalText(path, `${JSON.stringify(external, null, 2)}\n`);

    await expect(repository.saveMeta(library, library.meta)).rejects.toThrow(
      "已被外部修改",
    );
  });

  it("灵魂索引提交失败时回滚新建的 record", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    const library = await repository.load();
    const custom = {
      ...library.meta.souls[0]!,
      id: "rollback-soul",
      name: "回滚灵魂",
      builtIn: false,
    };
    const beforeIndex = storage.getText(CHARACTER_SOUL_INDEX_PATH);
    storage.failWritePathOnce = CHARACTER_SOUL_INDEX_PATH;

    await expect(
      repository.saveMeta(library, {
        ...library.meta,
        souls: [...library.meta.souls, custom],
      }),
    ).rejects.toThrow("Injected write failure");

    expect(storage.getText(CHARACTER_SOUL_INDEX_PATH)).toBe(beforeIndex);
    expect(storage.getText(characterSoulRecordPath(custom.id))).toBeUndefined();
  });

  it("删除角色灵魂后更新索引并清理孤立 record", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelCharacterLibraryRepository(storage);
    let library = await repository.load();
    const custom = {
      ...library.meta.souls[0]!,
      id: "custom-soul",
      name: "自定义灵魂",
      builtIn: false,
    };
    library = await repository.saveMeta(library, {
      ...library.meta,
      souls: [...library.meta.souls, custom],
    });
    expect(storage.getText(characterSoulRecordPath(custom.id))).toBeDefined();

    library = await repository.saveMeta(library, {
      ...library.meta,
      souls: library.meta.souls.filter((soul) => soul.id !== custom.id),
    });

    expect(storage.getText(characterSoulRecordPath(custom.id))).toBeUndefined();
    expect(library.meta.souls.some((soul) => soul.id === custom.id)).toBe(
      false,
    );
  });

  it("不迁移旧 library.json 中内嵌的角色灵魂", async () => {
    const storage = createEmptyNovelStorage();
    await storage.createText(
      CHARACTER_LIBRARY_PATHS.index,
      `${JSON.stringify({ schemaVersion: 1, characters: [] }, null, 2)}\n`,
      { createParents: true },
    );
    await storage.createText(
      CHARACTER_LIBRARY_PATHS.meta,
      `${JSON.stringify(createDefaultCharacterLibraryMeta(), null, 2)}\n`,
    );

    await expect(
      createNovelCharacterLibraryRepository(storage).load(),
    ).rejects.toThrow("旧内嵌灵魂数据不兼容且不迁移");
  });
});
