import { describe, expect, it } from "vitest";

import {
  createNovelPromptLibraryRepository,
  createPromptLibraryInitializationFiles,
} from "./promptLibraryRepository";
import {
  NOVEL_WORKBENCH_PROMPT_COUNT,
  STORYFORGE_PROMPT_COUNT,
  STORYFORGE_PROMPT_INSTALLATION_ID,
} from "../business/promptLibraryDefaults";
import { PROMPT_LIBRARY_REGISTRY_PATH } from "../entities/promptLibrarySchema";
import {
  createEmptyNovelStorage,
  NovelMemoryStorage,
} from "../../../shared/infrastructure/testStorage";

describe("createNovelPromptLibraryRepository", () => {
  it("bootstraps a complete editable StoryForge skill-pack copy", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelPromptLibraryRepository(storage);

    const library = await repository.load();

    expect(library.model.packs.map((pack) => pack.id)).toEqual([
      STORYFORGE_PROMPT_INSTALLATION_ID,
    ]);
    expect(library.model.prompts).toHaveLength(
      STORYFORGE_PROMPT_COUNT + NOVEL_WORKBENCH_PROMPT_COUNT,
    );
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
      STORYFORGE_PROMPT_COUNT + NOVEL_WORKBENCH_PROMPT_COUNT,
    );
    expect(paths).toContain(
      "prompts/installations/storyforge.prompt-library/content/prompts/characters/assist.md",
    );
    expect(paths).toContain(
      "prompts/installations/storyforge.prompt-library/content/prompts/general/worldview/dimension/generate.md",
    );
    expect(paths).toContain(
      "prompts/installations/storyforge.prompt-library/content/prompts/genre-packs/xianxia/chapter/content/generate.md",
    );
  });

  it("adds the built-in人物库 prompt to an existing StoryForge-only project", async () => {
    const initializationFiles = createPromptLibraryInitializationFiles();
    const registryFile = initializationFiles.find(
      (file) => file.path === PROMPT_LIBRARY_REGISTRY_PATH,
    )!;
    const registry = JSON.parse(registryFile.content) as {
      groups: Array<{ sourcePath: string }>;
      prompts: Array<{ promptId: string }>;
    };
    const oldRegistry =
      JSON.stringify(
        {
          ...registry,
          groups: registry.groups.filter(
            (record) => record.sourcePath !== "prompts/characters",
          ),
          prompts: registry.prompts.filter(
            (record) => record.promptId !== "novel.characters.assist",
          ),
        },
        null,
        2,
      ) + "\n";
    const oldFiles = Object.fromEntries(
      initializationFiles
        .filter(
          (file) =>
            file.path === PROMPT_LIBRARY_REGISTRY_PATH ||
            !file.path.endsWith("/prompts/characters/assist.md"),
        )
        .map((file) => [
          file.path,
          file.path === PROMPT_LIBRARY_REGISTRY_PATH
            ? oldRegistry
            : file.content,
        ]),
    );
    const storage = new NovelMemoryStorage(oldFiles);
    const library = await createNovelPromptLibraryRepository(storage).load();

    expect(library.model.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "novel.characters.assist",
          skillPackId: STORYFORGE_PROMPT_INSTALLATION_ID,
        }),
      ]),
    );
    expect(storage.getText("prompts/registry.json")).toContain(
      '"installationId": "storyforge.prompt-library"',
    );
  });

  it("merges the legacy workbench installation without losing user content", async () => {
    const initializationFiles = createPromptLibraryInitializationFiles();
    const registryFile = initializationFiles.find(
      (file) => file.path === PROMPT_LIBRARY_REGISTRY_PATH,
    )!;
    const registry = JSON.parse(registryFile.content) as {
      schemaVersion: number;
      installations: Array<Record<string, unknown>>;
      groups: Array<Record<string, unknown>>;
      prompts: Array<Record<string, unknown>>;
    };
    const legacyInstallationId = "myagents.novel.base";
    const oldContentPath =
      "prompts/installations/myagents.novel.base/content/prompts/characters/assist.md";
    const userContent = "# 作者定制的人物库提示词\n";
    const characterPrompt = registry.prompts.find(
      (prompt) => prompt.promptId === "novel.characters.assist",
    )!;
    const legacyRegistry = {
      ...registry,
      installations: [
        ...registry.installations,
        {
          installationId: legacyInstallationId,
          packageId: legacyInstallationId,
          name: "MyAgents 小说工作台提示词",
          source: "builtin",
          version: "1.0.0",
          enabled: true,
          updatedAt: "2026-08-10",
          description: "小说工作台人物库 Agent 的受控设计协议。",
          copyNumber: 1,
          modified: false,
        },
      ],
      groups: [
        ...registry.groups.filter(
          (group) => group.id !== "storyforge.prompt-library:characters",
        ),
        {
          id: `${legacyInstallationId}:root`,
          name: "MyAgents 小说工作台提示词",
          description: "小说工作台内置 Agent 场景提示词",
          parentId: null,
          nodeKind: "pack-root",
          installationId: legacyInstallationId,
          sourcePath: "",
          userCreated: false,
          modified: false,
          enabled: true,
          scope: { kind: "global" },
        },
        {
          id: `${legacyInstallationId}:prompts`,
          name: "prompts",
          description: "prompts",
          parentId: `${legacyInstallationId}:root`,
          nodeKind: "directory",
          installationId: legacyInstallationId,
          sourcePath: "prompts",
          userCreated: false,
          modified: false,
          enabled: true,
          scope: { kind: "global" },
        },
        {
          id: `${legacyInstallationId}:characters`,
          name: "人物库",
          description: "角色、关系、灵魂、种族与分组设计",
          parentId: `${legacyInstallationId}:prompts`,
          nodeKind: "directory",
          installationId: legacyInstallationId,
          sourcePath: "prompts/characters",
          userCreated: false,
          modified: false,
          enabled: true,
          scope: { kind: "global" },
        },
      ],
      prompts: [
        ...registry.prompts.filter(
          (prompt) => prompt.promptId !== "novel.characters.assist",
        ),
        {
          ...characterPrompt,
          instanceId: `${legacyInstallationId}:novel.characters.assist`,
          groupId: `${legacyInstallationId}:characters`,
          installationId: legacyInstallationId,
          contentPath: oldContentPath,
          overridden: true,
        },
      ],
    };
    const oldFiles = Object.fromEntries(
      initializationFiles
        .filter((file) => file.path !== characterPrompt.contentPath)
        .map((file) => [
          file.path,
          file.path === PROMPT_LIBRARY_REGISTRY_PATH
            ? `${JSON.stringify(legacyRegistry, null, 2)}\n`
            : file.content,
        ]),
    );
    oldFiles[oldContentPath] = userContent;
    const storage = new NovelMemoryStorage(oldFiles);
    const library = await createNovelPromptLibraryRepository(storage).load();

    const migrated = library.model.prompts.find(
      (prompt) => prompt.id === "novel.characters.assist",
    );
    expect(library.model.packs.map((pack) => pack.id)).toEqual([
      STORYFORGE_PROMPT_INSTALLATION_ID,
    ]);
    expect(migrated).toEqual(
      expect.objectContaining({
        instanceId: "storyforge.prompt-library:novel.characters.assist",
        skillPackId: STORYFORGE_PROMPT_INSTALLATION_ID,
        content: userContent,
      }),
    );
    expect(storage.getText(migrated?.contentPath ?? "")).toBe(userContent);
    expect(storage.getText(oldContentPath)).toBeUndefined();
    expect(storage.getText(PROMPT_LIBRARY_REGISTRY_PATH)).not.toContain(
      legacyInstallationId,
    );
  });

  it("migrates legacy StoryForge display metadata without changing stable IDs", async () => {
    const initializationFiles = createPromptLibraryInitializationFiles();
    const registryFile = initializationFiles.find(
      (file) => file.path === PROMPT_LIBRARY_REGISTRY_PATH,
    )!;
    const registry = JSON.parse(registryFile.content) as {
      readonly schemaVersion: number;
      readonly installations: readonly {
        readonly installationId: string;
        readonly name: string;
        readonly description: string;
        readonly [key: string]: unknown;
      }[];
      readonly groups: readonly {
        readonly installationId: string;
        readonly name: string;
        readonly description: string;
        readonly [key: string]: unknown;
      }[];
      readonly prompts: readonly {
        readonly [key: string]: unknown;
      }[];
    };
    const legacyRegistry = {
      ...registry,
      installations: registry.installations.map((pack) =>
        pack.installationId === STORYFORGE_PROMPT_INSTALLATION_ID
          ? {
              ...pack,
              name: "StoryForge 小说提示词库",
              description: "从 StoryForge 3.7.5 导入的完整小说提示词快照",
              modified: true,
            }
          : pack,
      ),
      groups: registry.groups.map((group) =>
        group.installationId === STORYFORGE_PROMPT_INSTALLATION_ID
          ? {
              ...group,
              name: group.name.replaceAll("My Novel Studio", "StoryForge"),
              description: group.description.replaceAll(
                "My Novel Studio",
                "StoryForge",
              ),
              modified: String(group.id).endsWith(":root"),
            }
          : group,
      ),
    };
    const legacyContentFile = initializationFiles.find(
      (file) =>
        file.path.endsWith(".md") &&
        file.content.includes('"sourceProject": "My Novel Studio"'),
    );
    if (!legacyContentFile) throw new Error("missing builtin prompt content");
    const oldFiles = Object.fromEntries(
      initializationFiles.map((file) => [
        file.path,
        file.path === PROMPT_LIBRARY_REGISTRY_PATH
          ? `${JSON.stringify(legacyRegistry, null, 2)}\n`
          : file.content
              .replaceAll(
                '"sourceProject": "My Novel Studio"',
                '"sourceProject": "StoryForge"',
              )
              .replaceAll(
                "你是 My Novel Studio 的全书编辑 Agent",
                "你是 StoryForge 的全书编辑 Agent",
              ),
      ]),
    );
    const storage = new NovelMemoryStorage(oldFiles);
    const library = await createNovelPromptLibraryRepository(storage).load();

    expect(library.model.packs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: STORYFORGE_PROMPT_INSTALLATION_ID,
          name: "My Novel Studio 小说提示词库",
          description: "My Novel Studio 默认小说提示词库（3.7.5）",
        }),
      ]),
    );
    expect(storage.getText(PROMPT_LIBRARY_REGISTRY_PATH)).not.toContain(
      "StoryForge 小说提示词库",
    );
    expect(storage.getText(legacyContentFile.path)).toContain(
      '"sourceProject": "My Novel Studio"',
    );
  });
});
