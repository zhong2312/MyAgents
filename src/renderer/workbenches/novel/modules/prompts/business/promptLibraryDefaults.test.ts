import { describe, expect, it } from "vitest";

import {
  createDefaultPromptLibraryModel,
  NOVEL_WORKBENCH_PROMPT_INSTALLATION_ID,
  STORYFORGE_PROMPT_COUNT,
  STORYFORGE_PROMPT_INSTALLATION_ID,
  STORYFORGE_WORLD_GUIDE_PROMPT_ID,
} from "./promptLibraryDefaults";
import { NOVEL_CHARACTERS_ASSIST_PROMPT_ID } from "../../characters/business/characterAgentPrompt";

describe("StoryForge prompt-library defaults", () => {
  it("contains the versioned StoryForge and小说工作台 installations", () => {
    const model = createDefaultPromptLibraryModel();

    expect(model.packs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: STORYFORGE_PROMPT_INSTALLATION_ID,
          packageId: STORYFORGE_PROMPT_INSTALLATION_ID,
          name: "StoryForge 小说提示词库",
          version: "3.7.5",
        }),
        expect.objectContaining({
          id: NOVEL_WORKBENCH_PROMPT_INSTALLATION_ID,
          packageId: NOVEL_WORKBENCH_PROMPT_INSTALLATION_ID,
          name: "MyAgents 小说工作台提示词",
          version: "1.0.0",
        }),
      ]),
    );
    expect(model.packs).toHaveLength(2);
    expect(model.packs.some((pack) => pack.id === "project.personal")).toBe(
      false,
    );
  });

  it("preserves all 89 StoryForge prompts and the人物库 Agent prompt", () => {
    const model = createDefaultPromptLibraryModel();
    const storyForgePrompts = model.prompts.filter(
      (prompt) => prompt.skillPackId === STORYFORGE_PROMPT_INSTALLATION_ID,
    );
    const promptIds = storyForgePrompts.map((prompt) => prompt.id);
    const sourcePaths = storyForgePrompts.map((prompt) => prompt.sourcePath);

    expect(storyForgePrompts).toHaveLength(STORYFORGE_PROMPT_COUNT);
    expect(storyForgePrompts.filter((prompt) => prompt.enabled)).toHaveLength(40);
    expect(storyForgePrompts.filter((prompt) => !prompt.enabled)).toHaveLength(49);
    expect(new Set(promptIds).size).toBe(promptIds.length);
    expect(new Set(sourcePaths).size).toBe(sourcePaths.length);
    expect(promptIds).toContain(STORYFORGE_WORLD_GUIDE_PROMPT_ID);
    expect(storyForgePrompts[0]).toEqual(
      expect.objectContaining({
        id: STORYFORGE_WORLD_GUIDE_PROMPT_ID,
        name: "内置-世界观维度生成",
      }),
    );
    expect(storyForgePrompts[0]?.content).toContain("## 系统提示词");
    expect(storyForgePrompts[0]?.content).toContain("## 用户提示词模板");
    expect(storyForgePrompts[0]?.content).toContain('"sourceVersion": "3.7.5"');
    expect(model.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: NOVEL_CHARACTERS_ASSIST_PROMPT_ID,
          skillPackId: NOVEL_WORKBENCH_PROMPT_INSTALLATION_ID,
          content: expect.stringContaining("novel_characters_get_context"),
        }),
      ]),
    );
  });

  it("builds a valid single-root directory tree with mapped genre scopes", () => {
    const model = createDefaultPromptLibraryModel();
    const groupsById = new Map(model.groups.map((group) => [group.id, group]));
    const roots = model.groups.filter((group) => group.parentId === null);
    const xianxiaPrompt = model.prompts.find(
      (prompt) => prompt.name === "仙侠包-章节正文",
    );
    const xianxiaGroup = groupsById.get(xianxiaPrompt?.groupId ?? "");

    expect(roots).toHaveLength(2);
    expect(roots.find((root) => root.skillPackId === STORYFORGE_PROMPT_INSTALLATION_ID)).toEqual(
      expect.objectContaining({
        nodeKind: "pack-root",
        skillPackId: STORYFORGE_PROMPT_INSTALLATION_ID,
      }),
    );
    for (const group of model.groups) {
      if (group.parentId) expect(groupsById.has(group.parentId)).toBe(true);
      expect([STORYFORGE_PROMPT_INSTALLATION_ID, NOVEL_WORKBENCH_PROMPT_INSTALLATION_ID]).toContain(
        group.skillPackId,
      );
    }
    expect(xianxiaGroup?.scope).toEqual(
      expect.objectContaining({
        kind: "genres",
        genres: expect.arrayContaining(["仙侠", "修真文明"]),
      }),
    );
  });
});
