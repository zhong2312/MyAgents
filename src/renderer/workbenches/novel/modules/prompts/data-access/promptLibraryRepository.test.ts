import { describe, expect, it } from "vitest";

import {
  createNovelPromptLibraryRepository,
  createPromptLibraryInitializationFiles,
} from "./promptLibraryRepository";
import { STORYFORGE_PROMPT_COUNT } from "../business/promptLibraryDefaults";
import { PROMPT_LIBRARY_REGISTRY_PATH } from "../entities/promptLibrarySchema";
import { createEmptyNovelStorage } from "../../../shared/infrastructure/testStorage";

describe("createNovelPromptLibraryRepository", () => {
  it("bootstraps a complete editable StoryForge skill-pack copy", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelPromptLibraryRepository(storage);

    const library = await repository.load();

    expect(library.model.packs.map((pack) => pack.id)).toEqual([
      "storyforge.prompt-library",
    ]);
    expect(library.model.prompts).toHaveLength(STORYFORGE_PROMPT_COUNT);
    expect(library.model.prompts[0]?.content).toContain("资深的世界设计师");
    expect(library.model.prompts[0]?.content).toContain("模板元数据");
    const registryText = storage.getText(PROMPT_LIBRARY_REGISTRY_PATH) ?? "";
    expect(registryText).not.toContain("资深的世界设计师");
    const registry = JSON.parse(registryText);
    expect(registry.installations[0]).toEqual(
      expect.objectContaining({
        installationId: "storyforge.prompt-library",
        packageId: "storyforge.prompt-library",
        version: "3.7.5",
        source: "builtin",
      }),
    );
    expect(registry.prompts[0].contentPath).toMatch(
      /^prompts\/installations\/storyforge\.prompt-library\/content\/prompts\//,
    );
    expect(storage.getText(registry.prompts[0].contentPath)).toContain(
      "{{projectName}}",
    );
  });

  it("persists prompt Markdown independently from registry metadata", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelPromptLibraryRepository(storage);
    const library = await repository.load();
    const target = library.model.prompts[0]!;
    const nextContent = "# 世界架构向导\n\n新的正文。\n";

    const saved = await repository.save(library, {
      ...library.model,
      prompts: library.model.prompts.map((prompt) =>
        prompt.instanceId === target.instanceId
          ? { ...prompt, content: nextContent, overridden: true }
          : prompt,
      ),
    });

    const savedPrompt = saved.model.prompts.find(
      (prompt) => prompt.instanceId === target.instanceId,
    );
    expect(savedPrompt?.content).toBe(nextContent);
    expect(storage.getText(savedPrompt?.contentPath ?? "")).toBe(nextContent);
    expect(storage.getText(PROMPT_LIBRARY_REGISTRY_PATH)).not.toContain(
      "新的正文",
    );
  });

  it("creates a new project prompt as Markdown before registering it", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelPromptLibraryRepository(storage);
    const library = await repository.load();
    const localPack = {
      id: "project.local",
      packageId: "project.local",
      name: "项目本地提示词",
      source: "project" as const,
      version: "1.0.0",
      enabled: true,
      updatedAt: "项目本地",
      description: "测试本地包",
      copyNumber: 1,
      modified: true,
    };
    const localRoot = {
      id: "project.local:root",
      name: "项目本地提示词",
      description: "",
      parentId: null,
      nodeKind: "pack-root" as const,
      skillPackId: localPack.id,
      sourcePath: "",
      userCreated: true,
      modified: true,
      enabled: true,
      scope: { kind: "global" as const },
    };
    const localGroup = {
      ...localRoot,
      id: "project.local:writing",
      name: "写作",
      parentId: localRoot.id,
      nodeKind: "directory" as const,
      sourcePath: "prompts/writing",
    };
    const prompt = {
      instanceId: "project.local:novel.scene.pacing",
      id: "novel.scene.pacing",
      name: "场景节奏校准",
      groupId: localGroup.id,
      version: "1.0.0",
      enabled: true,
      overridden: true,
      skillPackId: localPack.id,
      scopeOverride: null,
      content: "# 场景节奏校准\n",
    } as const;

    const saved = await repository.save(library, {
      ...library.model,
      packs: [...library.model.packs, localPack],
      groups: [...library.model.groups, localRoot, localGroup],
      prompts: [...library.model.prompts, prompt],
    });

    const created = saved.model.prompts.find(
      (item) => item.instanceId === prompt.instanceId,
    );
    expect(created?.contentPath).toBe(
      "prompts/installations/project.local/content/_local/project.local%3Anovel.scene.pacing.md",
    );
    expect(storage.getText(created?.contentPath ?? "")).toBe(prompt.content);
    expect(
      JSON.parse(storage.getText(PROMPT_LIBRARY_REGISTRY_PATH) ?? "").prompts,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: prompt.instanceId,
          promptId: prompt.id,
        }),
      ]),
    );
  });

  it("rejects a save after the Markdown file changed outside MyAgents", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelPromptLibraryRepository(storage);
    const library = await repository.load();
    const target = library.model.prompts[0]!;
    storage.setExternalText(target.contentPath!, "人工编辑后的版本\n");

    await expect(
      repository.save(library, {
        ...library.model,
        prompts: library.model.prompts.map((prompt) =>
          prompt.instanceId === target.instanceId
            ? { ...prompt, content: "界面中的旧草稿\n" }
            : prompt,
        ),
      }),
    ).rejects.toThrow("File changed externally");
    expect(storage.getText(target.contentPath!)).toBe("人工编辑后的版本\n");
  });

  it("exposes deterministic initialization files for new novel projects", () => {
    const files = createPromptLibraryInitializationFiles();
    const paths = files.map((file) => file.path);

    expect(paths.at(-1)).toBe(PROMPT_LIBRARY_REGISTRY_PATH);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((path) => path.endsWith(".md"))).toHaveLength(
      STORYFORGE_PROMPT_COUNT,
    );
    expect(paths).toContain(
      "prompts/installations/storyforge.prompt-library/content/prompts/general/worldview/dimension/generate.md",
    );
    expect(paths).toContain(
      "prompts/installations/storyforge.prompt-library/content/prompts/genre-packs/xianxia/chapter/content/generate.md",
    );
  });
});
