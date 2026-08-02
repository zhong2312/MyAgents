import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useDomainIndex } from "./useDomainIndex";
import { NovelMemoryStorage } from "./testStorage";

function storageWithCharacter(name: string): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "characters/index.json": JSON.stringify({
      schemaVersion: 1,
      characters: [
        {
          id: "char-1",
          name,
          alias: "",
          roleWeight: "npc",
          archetype: "",
          alignment: "",
          status: "active",
          summary: "",
          identities: [],
          age: "",
          currentRealm: "",
          realmProgressNodes: [],
          baseLifespan: "",
          lifespanLoss: "",
          spiritRoot: "",
          daoBody: "",
          cultivationMethod: "",
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
        },
      ],
    }),
  });
}

describe("useDomainIndex", () => {
  it("激活时构建索引并在外部变更后防抖重建", async () => {
    const storage = storageWithCharacter("洛言");
    const { result } = renderHook(() => useDomainIndex(storage, true));

    await waitFor(() => {
      expect(result.current?.entities).toHaveLength(1);
    });
    expect(result.current?.entities[0]?.name).toBe("洛言");

    // 外部修改角色名（触发 storage.watch）→ 防抖 500ms 后索引更新
    act(() => {
      storage.setExternalText(
        "characters/index.json",
        storage
          .getText("characters/index.json")!
          .replace("洛言", "苏夜"),
      );
    });

    await waitFor(
      () => {
        expect(result.current?.entities[0]?.name).toBe("苏夜");
      },
      { timeout: 2000 },
    );
  });

  it("未激活时不构建索引", async () => {
    const storage = storageWithCharacter("洛言");
    const { result } = renderHook(() => useDomainIndex(storage, false));

    // 给 watch 与重建留出时间，断言仍未构建
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current).toBeNull();
  });
});
