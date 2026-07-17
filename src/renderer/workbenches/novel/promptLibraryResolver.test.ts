import { describe, expect, it } from "vitest";

import { createDefaultPromptLibraryModel } from "./promptLibraryDefaults";
import {
  renderPromptTemplate,
  resolvePromptSet,
  selectPromptForExecution,
} from "./promptLibraryResolver";

describe("promptLibraryResolver", () => {
  it("returns the configured world guide as an executable prompt", () => {
    const model = createDefaultPromptLibraryModel();
    const selection = selectPromptForExecution(
      resolvePromptSet(model, ["玄幻"]),
      "novel.world.guide",
    );

    expect(selection.status).toBe("ready");
    if (selection.status === "ready") {
      expect(selection.activation.pack.name).toBe("StoryForge 小说提示词库");
    }
  });

  it("blocks execution when two enabled installations provide the same prompt id", () => {
    const model = createDefaultPromptLibraryModel();
    const original = model.prompts[0]!;
    const duplicatePack = {
      ...model.packs[0]!,
      id: "storyforge.prompt-library#2",
      name: "StoryForge 小说提示词库 · 副本 2",
      copyNumber: 2,
    };
    const duplicateRoot = {
      ...model.groups[0]!,
      id: "pack-base-root#2",
      name: duplicatePack.name,
      skillPackId: duplicatePack.id,
    };
    const duplicatePrompt = {
      ...original,
      instanceId: `${duplicatePack.id}:${original.id}`,
      groupId: duplicateRoot.id,
      skillPackId: duplicatePack.id,
    };
    const selection = selectPromptForExecution(
      resolvePromptSet(
        {
          packs: [...model.packs, duplicatePack],
          groups: [...model.groups, duplicateRoot],
          prompts: [...model.prompts, duplicatePrompt],
        },
        ["玄幻"],
      ),
      original.id,
    );

    expect(selection.status).toBe("conflict");
  });

  it("injects declared variables and rejects incomplete execution context", () => {
    expect(
      renderPromptTemplate("目标：{{target}}\n上下文：{{context}}", {
        target: "创建世界",
        context: "项目 A",
      }),
    ).toBe("目标：创建世界\n上下文：项目 A");
    expect(() =>
      renderPromptTemplate("目标：{{target}}\n上下文：{{context}}", {
        target: "创建世界",
      }),
    ).toThrow("提示词缺少变量：context");
  });

  it("renders StoryForge conditional blocks before validating variables", () => {
    expect(
      renderPromptTemplate(
        "{{#if usesTone}}基调：{{tone}}{{/if}}{{#if omitted}}隐藏：{{missing}}{{/if}}",
        { usesTone: "1", tone: "冷峻", omitted: "" },
      ),
    ).toBe("基调：冷峻");
  });
});
