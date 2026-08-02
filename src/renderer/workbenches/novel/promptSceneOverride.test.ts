import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "./testStorage";
import { resolveScenePromptOverride } from "./promptSceneOverride";

function customPromptStorage(): Record<string, string> {
  return {
    "prompts/registry.json": JSON.stringify({
      schemaVersion: 1,
      installations: [
        {
          installationId: "pack-custom",
          packageId: "custom",
          name: "自定义包",
          source: "project",
          version: "1.0.0",
          enabled: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          description: "",
          copyNumber: 1,
          modified: true,
        },
      ],
      groups: [
        {
          id: "pack-root-custom",
          name: "自定义包",
          description: "",
          parentId: null,
          nodeKind: "pack-root",
          installationId: "pack-custom",
          sourcePath: "",
          userCreated: false,
          modified: false,
          enabled: true,
          scope: { kind: "global" },
        },
        {
          id: "custom",
          name: "自定义",
          description: "",
          parentId: "pack-root-custom",
          nodeKind: "directory",
          installationId: "pack-custom",
          sourcePath: "",
          userCreated: true,
          modified: true,
          enabled: true,
          scope: { kind: "global" },
        },
      ],
      prompts: [
        {
          instanceId: "novel.timeline.assist#pack-custom",
          promptId: "novel.timeline.assist",
          name: "时间线助手",
          groupId: "custom",
          version: "1.0.0",
          enabled: true,
          overridden: true,
          installationId: "pack-custom",
          scopeOverride: null,
          contentPath:
            "prompts/installations/pack-custom/content/_local/novel.timeline.assist%23pack-custom.md",
        },
      ],
    }),
    "prompts/installations/pack-custom/content/_local/novel.timeline.assist%23pack-custom.md":
      "你是{{projectName}}的时间线助手，题材：{{genres}}。\n作者要求：{{requirement}}",
  };
}

describe("resolveScenePromptOverride", () => {
  it("自定义提示词存在且启用时返回渲染后的模板", async () => {
    const storage = new (await import("./testStorage")).NovelMemoryStorage(
      customPromptStorage(),
    );
    const override = await resolveScenePromptOverride(
      storage,
      "novel.timeline.assist",
      ["玄幻"],
      {
        projectName: "测试小说",
        genres: "玄幻",
        requirement: "检查伏笔",
      },
    );
    expect(override.status).toBe("ready");
    if (override.status === "ready") {
      expect(override.content).toContain("你是测试小说的时间线助手");
      expect(override.content).toContain("作者要求：检查伏笔");
    }
  });

  it("未自定义的场景回退内置提示词", async () => {
    const storage = createEmptyNovelStorage();
    const override = await resolveScenePromptOverride(
      storage,
      "novel.manuscript.generate",
      ["玄幻"],
      { projectName: "测试小说", genres: "玄幻", requirement: "" },
    );
    expect(override.status).toBe("fallback");
  });

  it("模板缺少变量时抛错，暴露模板问题", async () => {
    const storage = new (await import("./testStorage")).NovelMemoryStorage(
      customPromptStorage(),
    );
    await expect(
      resolveScenePromptOverride(storage, "novel.timeline.assist", ["玄幻"], {
        projectName: "测试小说",
      }),
    ).rejects.toThrow(/缺少变量/);
  });
});
