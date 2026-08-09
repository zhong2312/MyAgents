import { describe, expect, it } from "vitest";

import type { CharacterSoulDefinition } from "./characterLibrarySchema";
import {
  CHARACTER_SOUL_INDEX_PATH,
  characterSoulFileMap,
  characterSoulRecordPath,
  createCharacterSoulFiles,
  loadCharacterSoulFiles,
  serializeCharacterSoulSnapshot,
} from "./characterSoulStorage";

function soul(id: string, name: string): CharacterSoulDefinition {
  return {
    id,
    builtIn: false,
    name,
    category: "决策",
    summary: `${name}摘要`,
    expressionDna: "表达",
    mentalModel: "模型",
    decisionHeuristics: "决策",
    valueAntiPatterns: "反模式",
    boundaries: "边界",
    expressionConflictKeywords: [],
    decisionConflictKeywords: [],
    valueConflictKeywords: [],
    amplificationKeywords: [],
  };
}

describe("角色灵魂目录存储", () => {
  it("索引只保存摘要，正文按 id 独立存储", async () => {
    const files = createCharacterSoulFiles([
      soul("soul-a", "甲魂"),
      soul("soul-b", "乙魂"),
    ]);
    const map = characterSoulFileMap(files);

    expect(JSON.parse(map.get(CHARACTER_SOUL_INDEX_PATH) ?? "{}")).toEqual({
      schemaVersion: 1,
      entries: [
        {
          id: "soul-a",
          name: "甲魂",
          category: "决策",
          builtIn: false,
          path: "characters/souls/records/soul-a.json",
        },
        {
          id: "soul-b",
          name: "乙魂",
          category: "决策",
          builtIn: false,
          path: "characters/souls/records/soul-b.json",
        },
      ],
    });
    expect(map.get(characterSoulRecordPath("soul-a"))).toContain(
      '"mentalModel": "模型"',
    );
    await expect(
      loadCharacterSoulFiles(async (path) => {
        const content = map.get(path);
        if (content === undefined) throw new Error(`missing: ${path}`);
        return content;
      }),
    ).resolves.toMatchObject({ souls: [{ id: "soul-a" }, { id: "soul-b" }] });
  });

  it("拒绝索引路径或摘要与记录漂移", async () => {
    const files = characterSoulFileMap(
      createCharacterSoulFiles([soul("soul-a", "甲魂")]),
    );
    const index = JSON.parse(files.get(CHARACTER_SOUL_INDEX_PATH) ?? "{}") as {
      entries: Array<{ path: string; name: string }>;
    };
    index.entries[0]!.name = "错误摘要";
    const changed = new Map(files).set(
      CHARACTER_SOUL_INDEX_PATH,
      `${JSON.stringify(index, null, 2)}\n`,
    );

    await expect(
      loadCharacterSoulFiles(async (path) => changed.get(path) ?? ""),
    ).rejects.toThrow("与角色灵魂索引摘要不一致");
  });

  it("目录快照不受 Map 插入顺序影响", () => {
    expect(
      serializeCharacterSoulSnapshot(
        new Map([
          ["b", "2"],
          ["a", "1"],
        ]),
      ),
    ).toBe(
      serializeCharacterSoulSnapshot(
        new Map([
          ["a", "1"],
          ["b", "2"],
        ]),
      ),
    );
  });
});
