import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "./testStorage";
import {
  buildFullGenerationQuickContext,
  countFullGenerationQuickContextItems,
  createFullGenerationQuickContextSelection,
  FULL_GENERATION_QUICK_CONTEXT_CHARACTER_LIMIT,
  getFullGenerationSettingIdsForNode,
  replaceFullGenerationQuickContextIds,
  toggleFullGenerationQuickContextId,
  type FullGenerationQuickContextCatalog,
} from "./fullGenerationQuickContext";

function catalog(
  previousContent = "前章正文",
): FullGenerationQuickContextCatalog {
  return {
    settingNodes: [
      {
        id: "world-root",
        parentId: null,
        name: "世界",
        typeId: "world",
        order: 0,
      },
      {
        id: "region-east",
        parentId: "world-root",
        name: "东境",
        typeId: "region",
        order: 0,
      },
    ],
    settings: [
      {
        id: "setting-law",
        nodeId: "world-root",
        templateId: null,
        name: "世界法则",
        group: "根设定",
        status: "completed",
        pagePath: "world/setting-library/pages/world-root/setting-law.md",
        entriesPath:
          "world/setting-library/entries/world-root/setting-law.json",
      },
      {
        id: "setting-east-city",
        nodeId: "region-east",
        templateId: null,
        name: "东境城池",
        group: "地理",
        status: "completed",
        pagePath:
          "world/setting-library/pages/region-east/setting-east-city.md",
        entriesPath:
          "world/setting-library/entries/region-east/setting-east-city.json",
      },
    ],
    timeline: null,
    narrativeLines: [],
    narrativeDirectories: [],
    narrativeChapters: [],
    characters: [],
    previousChapters: [
      {
        id: "chapter-000001",
        number: 1,
        displayNumber: 1,
        title: "雨夜",
        path: "manuscript/chapters/000001.md",
        status: "complete",
        directoryId: null,
        order: 0,
        narrativeChapterId: null,
        planningMode: "detached",
        trackingStatus: "idle",
        lastTrackedAt: null,
        content: previousContent,
        words: previousContent.length,
      },
    ],
    inspirations: [],
    factions: [],
    issues: [],
  };
}

describe("正文完整生成快速上下文", () => {
  it("支持世界架构层级选择并统计人工资料项", () => {
    const source = catalog();
    expect(getFullGenerationSettingIdsForNode(source, "world-root")).toEqual([
      "setting-law",
      "setting-east-city",
    ]);

    let selection = createFullGenerationQuickContextSelection(1);
    selection = replaceFullGenerationQuickContextIds(
      selection,
      "settingIds",
      getFullGenerationSettingIdsForNode(source, "world-root"),
    );
    selection = toggleFullGenerationQuickContextId(
      selection,
      "characterIds",
      "character-hero",
    );

    expect(selection.settingIds).toEqual(["setting-law", "setting-east-city"]);
    expect(countFullGenerationQuickContextItems(selection)).toBe(4);
  });

  it("把作者选择的前文一次性写入快速上下文", async () => {
    const context = await buildFullGenerationQuickContext({
      storage: createEmptyNovelStorage(),
      catalog: catalog(),
      selection: createFullGenerationQuickContextSelection(1),
    });

    expect(context).toContain("【快速模式资料快照】");
    expect(context).toContain("不得调用工具");
    expect(context).toContain("第 1 章 · 雨夜");
    expect(context).toContain("前章正文");
  });

  it("资料超过一次性上下文上限时要求作者减少选择", async () => {
    await expect(
      buildFullGenerationQuickContext({
        storage: createEmptyNovelStorage(),
        catalog: catalog(
          "字".repeat(FULL_GENERATION_QUICK_CONTEXT_CHARACTER_LIMIT),
        ),
        selection: createFullGenerationQuickContextSelection(1),
      }),
    ).rejects.toThrow("请减少资料后重试");
  });
});
