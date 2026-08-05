import { describe, expect, it } from "vitest";

import {
  createDefaultPromptLibraryModel,
  STORYFORGE_PROMPT_COUNT,
  STORYFORGE_PROMPT_INSTALLATION_ID,
  STORYFORGE_WORLD_GUIDE_PROMPT_ID,
} from "./promptLibraryDefaults";

describe("StoryForge prompt-library defaults", () => {
  it("contains only the versioned StoryForge installation", () => {
    const model = createDefaultPromptLibraryModel();

    expect(model.packs).toEqual([
      expect.objectContaining({
        id: STORYFORGE_PROMPT_INSTALLATION_ID,
        packageId: STORYFORGE_PROMPT_INSTALLATION_ID,
        name: "StoryForge 小说提示词库",
        version: "3.7.5",
      }),
    ]);
    expect(model.packs.some((pack) => pack.id === "myagents.novel.base")).toBe(
      false,
    );
    expect(model.packs.some((pack) => pack.id === "project.personal")).toBe(
      false,
    );
  });

  it("preserves all 89 StoryForge prompts and their default activation state", () => {
    const model = createDefaultPromptLibraryModel();
    const promptIds = model.prompts.map((prompt) => prompt.id);
    const sourcePaths = model.prompts.map((prompt) => prompt.sourcePath);

    expect(model.prompts).toHaveLength(STORYFORGE_PROMPT_COUNT);
    expect(model.prompts.filter((prompt) => prompt.enabled)).toHaveLength(40);
    expect(model.prompts.filter((prompt) => !prompt.enabled)).toHaveLength(49);
    expect(new Set(promptIds).size).toBe(promptIds.length);
    expect(new Set(sourcePaths).size).toBe(sourcePaths.length);
    expect(promptIds).toContain(STORYFORGE_WORLD_GUIDE_PROMPT_ID);
    expect(model.prompts[0]).toEqual(
      expect.objectContaining({
        id: STORYFORGE_WORLD_GUIDE_PROMPT_ID,
        name: "内置-世界观维度生成",
      }),
    );
    expect(model.prompts[0]?.content).toContain("## 系统提示词");
    expect(model.prompts[0]?.content).toContain("## 用户提示词模板");
    expect(model.prompts[0]?.content).toContain('"sourceVersion": "3.7.5"');
  });

  it("builds a valid single-root directory tree with mapped genre scopes", () => {
    const model = createDefaultPromptLibraryModel();
    const groupsById = new Map(model.groups.map((group) => [group.id, group]));
    const roots = model.groups.filter((group) => group.parentId === null);
    const xianxiaPrompt = model.prompts.find(
      (prompt) => prompt.name === "仙侠包-章节正文",
    );
    const xianxiaGroup = groupsById.get(xianxiaPrompt?.groupId ?? "");

    expect(roots).toHaveLength(1);
    expect(roots[0]).toEqual(
      expect.objectContaining({
        nodeKind: "pack-root",
        skillPackId: STORYFORGE_PROMPT_INSTALLATION_ID,
      }),
    );
    for (const group of model.groups) {
      if (group.parentId) expect(groupsById.has(group.parentId)).toBe(true);
      expect(group.skillPackId).toBe(STORYFORGE_PROMPT_INSTALLATION_ID);
    }
    expect(xianxiaGroup?.scope).toEqual(
      expect.objectContaining({
        kind: "genres",
        genres: expect.arrayContaining(["仙侠", "修真文明"]),
      }),
    );
  });
});
