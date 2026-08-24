import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createDefaultPromptLibraryModel,
  NOVEL_WORKBENCH_PROMPT_INSTALLATION_ID,
  STORYFORGE_PROMPT_INSTALLATION_ID,
} from "../business/promptLibraryDefaults";
import {
  PROMPT_LIBRARY_REGISTRY_PATH,
  PROMPT_LIBRARY_SCHEMA_VERSION,
  parsePromptLibraryRegistry,
  registryToPromptLibraryModel,
  serializePromptLibraryRegistry,
  type PromptDefinition,
  type PromptLibraryModel,
  type PromptLibraryRegistry,
} from "../entities/promptLibrarySchema";

export interface LoadedPromptLibrary {
  readonly model: PromptLibraryModel;
  readonly registryContent: string;
  readonly contentByInstanceId: ReadonlyMap<string, string>;
}

export interface NovelPromptLibraryRepository {
  load(): Promise<LoadedPromptLibrary>;
  save(
    current: LoadedPromptLibrary,
    model: PromptLibraryModel,
  ): Promise<LoadedPromptLibrary>;
}

function encodeInstallationId(installationId: string): string {
  return encodeURIComponent(installationId);
}

function localPromptFileName(instanceId: string): string {
  return `${encodeURIComponent(instanceId)}.md`;
}

function promptContentPath(prompt: PromptDefinition): string {
  if (prompt.contentPath) return prompt.contentPath;
  const base = `prompts/installations/${encodeInstallationId(prompt.skillPackId)}/content`;
  if (prompt.sourcePath) return `${base}/${prompt.sourcePath}`;
  return `${base}/_local/${localPromptFileName(prompt.instanceId)}`;
}

function modelToRegistry(model: PromptLibraryModel): PromptLibraryRegistry {
  return {
    schemaVersion: PROMPT_LIBRARY_SCHEMA_VERSION,
    installations: model.packs.map((pack) => ({
      installationId: pack.id,
      packageId: pack.packageId,
      name: pack.name,
      source: pack.source,
      ...(pack.repository ? { repository: pack.repository } : {}),
      version: pack.version,
      enabled: pack.enabled,
      updatedAt: pack.updatedAt,
      description: pack.description,
      copyNumber: pack.copyNumber,
      modified: pack.modified,
    })),
    groups: model.groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      parentId: group.parentId,
      nodeKind: group.nodeKind,
      installationId: group.skillPackId,
      sourcePath: group.sourcePath,
      userCreated: group.userCreated,
      modified: group.modified,
      enabled: group.enabled,
      scope: group.scope,
    })),
    prompts: model.prompts.map((prompt) => ({
      instanceId: prompt.instanceId,
      promptId: prompt.id,
      name: prompt.name,
      groupId: prompt.groupId,
      version: prompt.version,
      enabled: prompt.enabled,
      overridden: prompt.overridden,
      installationId: prompt.skillPackId,
      scopeOverride: prompt.scopeOverride,
      contentPath: promptContentPath(prompt),
      ...(prompt.sourcePath ? { sourcePath: prompt.sourcePath } : {}),
    })),
  };
}

function buildInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  const model = createDefaultPromptLibraryModel();
  const registry = modelToRegistry(model);
  return [
    ...registry.prompts.map((record) => ({
      path: record.contentPath,
      content:
        model.prompts.find((prompt) => prompt.instanceId === record.instanceId)
          ?.content ?? "",
    })),
    {
      path: PROMPT_LIBRARY_REGISTRY_PATH,
      content: serializePromptLibraryRegistry(registry),
    },
  ];
}

export function createPromptLibraryInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return Object.freeze(
    buildInitializationFiles().map((file) => Object.freeze({ ...file })),
  );
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, content, { createParents: true });
  } catch {
    return storage.readText(path);
  }
}

function migrateDefaultPromptMetadata(
  current: PromptLibraryRegistry,
  defaults: PromptLibraryRegistry,
): PromptLibraryRegistry {
  const legacyPackName = "StoryForge 小说提示词库";
  const legacyPackDescription = "从 StoryForge 3.7.5 导入的完整小说提示词快照";
  const defaultPacks = new Map(
    defaults.installations.map((pack) => [pack.installationId, pack]),
  );
  const defaultGroups = new Map(
    defaults.groups.map((group) => [group.id, group]),
  );
  let changed = false;
  const installations = current.installations.map((pack) => {
    const defaultPack = defaultPacks.get(pack.installationId);
    if (!defaultPack) {
      return pack;
    }
    const canRefreshDefaults = !pack.modified;
    const nextName =
      canRefreshDefaults || pack.name === legacyPackName
        ? defaultPack.name
        : pack.name;
    const nextDescription =
      canRefreshDefaults || pack.description === legacyPackDescription
        ? defaultPack.description
        : pack.description;
    if (nextName === pack.name && nextDescription === pack.description) {
      return pack;
    }
    changed = true;
    return {
      ...pack,
      name: nextName,
      description: nextDescription,
    };
  });
  const groups = current.groups.map((group) => {
    const defaultGroup = defaultGroups.get(group.id);
    if (!defaultGroup) {
      return group;
    }
    const canRefreshDefaults = !group.modified;
    const nextName =
      canRefreshDefaults || group.name === "StoryForge 小说提示词库"
        ? defaultGroup.name
        : group.name;
    const nextDescription =
      canRefreshDefaults ||
      group.description === "从 StoryForge 3.7.5 导入的完整小说提示词快照" ||
      group.description === "StoryForge 题材模板，按小说题材决定是否进入启用集"
        ? defaultGroup.description
        : group.description;
    if (nextName === group.name && nextDescription === group.description) {
      return group;
    }
    changed = true;
    return {
      ...group,
      name: nextName,
      description: nextDescription,
    };
  });
  return changed ? { ...current, installations, groups } : current;
}

function migrateDefaultPromptContent(content: string): string {
  return content
    .replaceAll(
      '"sourceProject": "StoryForge"',
      '"sourceProject": "My Novel Studio"',
    )
    .replaceAll(
      "你是 StoryForge 的全书编辑 Agent",
      "你是 My Novel Studio 的全书编辑 Agent",
    );
}

type PromptContentWrite = {
  readonly path: string;
  readonly previous: string;
  readonly next: string;
};

type PromptContentCreate = {
  readonly path: string;
  readonly content: string;
};

const LEGACY_NOVEL_INSTALLATION_ID = NOVEL_WORKBENCH_PROMPT_INSTALLATION_ID;
type PromptRegistryGroup = PromptLibraryRegistry["groups"][number];
type PromptRegistryRecord = PromptLibraryRegistry["prompts"][number];

function canonicalPromptGroupId(sourcePath: string): string | undefined {
  switch (sourcePath) {
    case "":
      return `${STORYFORGE_PROMPT_INSTALLATION_ID}:root`;
    case "prompts":
      return `${STORYFORGE_PROMPT_INSTALLATION_ID}:prompts`;
    case "prompts/characters":
      return `${STORYFORGE_PROMPT_INSTALLATION_ID}:characters`;
    default:
      return undefined;
  }
}

async function chooseAvailablePromptPath(
  storage: WorkbenchStorage,
  preferredPath: string,
  plannedPaths: ReadonlySet<string>,
): Promise<string> {
  const extensionIndex = preferredPath.lastIndexOf(".");
  const stem =
    extensionIndex > 0 ? preferredPath.slice(0, extensionIndex) : preferredPath;
  const extension =
    extensionIndex > 0 ? preferredPath.slice(extensionIndex) : "";
  for (let suffix = 0; ; suffix += 1) {
    const candidate =
      suffix === 0 ? preferredPath : `${stem}-${suffix}${extension}`;
    if (plannedPaths.has(candidate)) continue;
    const [info] = await storage.stat([candidate]);
    if (!info?.exists) return candidate;
  }
}

async function ensureMigrationFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
  plannedCreates: Map<string, string>,
): Promise<{ readonly path: string; readonly create: boolean }> {
  const planned = plannedCreates.get(path);
  if (planned !== undefined) {
    if (planned === content) return { path, create: false };
    const alternate = await chooseAvailablePromptPath(
      storage,
      path,
      new Set(plannedCreates.keys()),
    );
    plannedCreates.set(alternate, content);
    return { path: alternate, create: true };
  }
  const [info] = await storage.stat([path]);
  if (!info?.exists) {
    plannedCreates.set(path, content);
    return { path, create: true };
  }
  const existing = await storage.readText(path);
  if (existing.content === content) return { path, create: false };
  const alternate = await chooseAvailablePromptPath(
    storage,
    path.replace(/\/([^/]*)$/, "/_local/$1"),
    new Set(plannedCreates.keys()),
  );
  plannedCreates.set(alternate, content);
  return { path: alternate, create: true };
}

function localMigrationPath(instanceId: string): string {
  return `prompts/installations/${encodeInstallationId(
    STORYFORGE_PROMPT_INSTALLATION_ID,
  )}/content/_local/${localPromptFileName(instanceId)}`;
}

async function migrateLegacyNovelWorkbenchInstallation(
  storage: WorkbenchStorage,
  current: PromptLibraryRegistry,
  defaults: PromptLibraryRegistry,
): Promise<{
  readonly registry: PromptLibraryRegistry;
  readonly creates: readonly PromptContentCreate[];
  readonly writes: readonly PromptContentWrite[];
  readonly removePaths: readonly string[];
}> {
  const migratedCurrent = migrateDefaultPromptMetadata(current, defaults);
  const defaultPack = defaults.installations.find(
    (pack) => pack.installationId === STORYFORGE_PROMPT_INSTALLATION_ID,
  );
  if (!defaultPack) throw new Error("My Novel Studio 默认安装副本缺失");

  const legacyGroups = migratedCurrent.groups.filter(
    (group) => group.installationId === LEGACY_NOVEL_INSTALLATION_ID,
  );
  const legacyPrompts = migratedCurrent.prompts.filter(
    (prompt) => prompt.installationId === LEGACY_NOVEL_INSTALLATION_ID,
  );
  const groupIdMap = new Map<string, string>();
  const defaultGroupsByPath = new Map(
    defaults.groups
      .filter((group) => group.installationId === defaultPack.installationId)
      .map((group) => [group.sourcePath, group]),
  );
  const retainedGroups = migratedCurrent.groups.filter(
    (group) => group.installationId !== LEGACY_NOVEL_INSTALLATION_ID,
  );
  const retainedGroupIds = new Set(retainedGroups.map((group) => group.id));

  for (const group of legacyGroups) {
    const canonicalId = canonicalPromptGroupId(group.sourcePath);
    const defaultGroup = defaultGroupsByPath.get(group.sourcePath);
    if (canonicalId && defaultGroup && !group.userCreated) {
      groupIdMap.set(group.id, canonicalId);
      continue;
    }
    let nextId = group.id;
    if (
      retainedGroupIds.has(nextId) ||
      [...groupIdMap.values()].includes(nextId)
    ) {
      nextId = `${STORYFORGE_PROMPT_INSTALLATION_ID}:migrated:${encodeURIComponent(group.id)}`;
    }
    groupIdMap.set(group.id, nextId);
    retainedGroupIds.add(nextId);
  }

  const migratedGroups: PromptRegistryGroup[] = legacyGroups.flatMap(
    (group) => {
      const nextId = groupIdMap.get(group.id);
      const canonicalId = canonicalPromptGroupId(group.sourcePath);
      const defaultGroup = defaultGroupsByPath.get(group.sourcePath);
      if (!nextId || (canonicalId && defaultGroup && !group.userCreated))
        return [];
      const mappedParent = group.parentId
        ? (groupIdMap.get(group.parentId) ??
          (retainedGroupIds.has(group.parentId) ? group.parentId : null))
        : null;
      return [
        {
          ...group,
          id: nextId,
          parentId: mappedParent ?? `${STORYFORGE_PROMPT_INSTALLATION_ID}:root`,
          nodeKind: "directory" as const,
          installationId: STORYFORGE_PROMPT_INSTALLATION_ID,
        },
      ];
    },
  );

  const allGroups = [...retainedGroups, ...migratedGroups];
  const allGroupIds = new Set(allGroups.map((group) => group.id));
  for (const group of defaults.groups) {
    if (
      group.installationId === defaultPack.installationId &&
      !allGroupIds.has(group.id)
    ) {
      allGroups.push(group);
      allGroupIds.add(group.id);
    }
  }

  const retainedPrompts = migratedCurrent.prompts.filter(
    (prompt) => prompt.installationId !== LEGACY_NOVEL_INSTALLATION_ID,
  );
  const promptIds = new Set(retainedPrompts.map((prompt) => prompt.promptId));
  const instanceIds = new Set(
    retainedPrompts.map((prompt) => prompt.instanceId),
  );
  const defaultPromptsById = new Map(
    defaults.prompts
      .filter((prompt) => prompt.installationId === defaultPack.installationId)
      .map((prompt) => [prompt.promptId, prompt]),
  );
  const plannedCreates = new Map<string, string>();
  const removePaths = new Set<string>();
  const migratedPrompts: PromptRegistryRecord[] = [];
  const defaultContentByPromptId = new Map(
    createDefaultPromptLibraryModel().prompts.map((prompt) => [
      prompt.id,
      prompt.content,
    ]),
  );

  for (const prompt of legacyPrompts) {
    const source = await storage.readText(prompt.contentPath);
    const defaultPrompt = defaultPromptsById.get(prompt.promptId);
    let targetPath =
      defaultPrompt?.contentPath ??
      `${localMigrationPath(
        `${STORYFORGE_PROMPT_INSTALLATION_ID}:${prompt.promptId}`,
      )}`;
    let nextInstanceId = `${STORYFORGE_PROMPT_INSTALLATION_ID}:${prompt.promptId}`;

    if (promptIds.has(prompt.promptId)) {
      nextInstanceId = `${nextInstanceId}:legacy`;
      targetPath = localMigrationPath(nextInstanceId);
    }
    if (instanceIds.has(nextInstanceId)) {
      let suffix = 2;
      while (instanceIds.has(`${nextInstanceId}:${suffix}`)) suffix += 1;
      nextInstanceId = `${nextInstanceId}:${suffix}`;
      targetPath = localMigrationPath(nextInstanceId);
    }
    const planned = await ensureMigrationFile(
      storage,
      targetPath,
      source.content,
      plannedCreates,
    );
    targetPath = planned.path;
    const mappedGroupId =
      groupIdMap.get(prompt.groupId) ??
      (allGroupIds.has(prompt.groupId)
        ? prompt.groupId
        : `${STORYFORGE_PROMPT_INSTALLATION_ID}:characters`);
    migratedPrompts.push({
      ...prompt,
      instanceId: nextInstanceId,
      groupId: mappedGroupId,
      installationId: STORYFORGE_PROMPT_INSTALLATION_ID,
      contentPath: targetPath,
    });
    promptIds.add(prompt.promptId);
    instanceIds.add(nextInstanceId);
    if (prompt.contentPath !== targetPath) removePaths.add(prompt.contentPath);
  }

  const missingDefaultPrompts: PromptRegistryRecord[] = [];
  for (const prompt of defaults.prompts.filter(
    (prompt) =>
      prompt.installationId === defaultPack.installationId &&
      !promptIds.has(prompt.promptId),
  )) {
    const planned = await ensureMigrationFile(
      storage,
      prompt.contentPath!,
      defaultContentByPromptId.get(prompt.promptId) ?? "",
      plannedCreates,
    );
    missingDefaultPrompts.push({ ...prompt, contentPath: planned.path });
    promptIds.add(prompt.promptId);
  }

  const existingPackIds = new Set(
    migratedCurrent.installations
      .filter((pack) => pack.installationId !== LEGACY_NOVEL_INSTALLATION_ID)
      .map((pack) => pack.installationId),
  );
  const installations = migratedCurrent.installations.filter(
    (pack) => pack.installationId !== LEGACY_NOVEL_INSTALLATION_ID,
  );
  if (!existingPackIds.has(defaultPack.installationId)) {
    installations.unshift(defaultPack);
  }
  const nextRegistry: PromptLibraryRegistry = {
    schemaVersion: migratedCurrent.schemaVersion,
    installations,
    groups: allGroups,
    prompts: [...retainedPrompts, ...migratedPrompts, ...missingDefaultPrompts],
  };

  const writes: PromptContentWrite[] = [];
  for (const prompt of current.prompts) {
    if (
      prompt.installationId !== STORYFORGE_PROMPT_INSTALLATION_ID ||
      prompt.overridden
    ) {
      continue;
    }
    const file = await storage.readText(prompt.contentPath);
    const next = migrateDefaultPromptContent(file.content);
    if (next !== file.content) {
      writes.push({ path: prompt.contentPath, previous: file.content, next });
    }
  }

  return {
    registry: nextRegistry,
    creates: [...plannedCreates].map(([path, content]) => ({ path, content })),
    writes,
    removePaths: [...removePaths],
  };
}

async function ensureNovelWorkbenchPromptInstallation(
  storage: WorkbenchStorage,
  registryFile: WorkbenchTextFile,
): Promise<void> {
  const current = parsePromptLibraryRegistry(registryFile.content);
  const defaults = modelToRegistry(createDefaultPromptLibraryModel());
  const migration = await migrateLegacyNovelWorkbenchInstallation(
    storage,
    current,
    defaults,
  );
  const nextRegistryContent = serializePromptLibraryRegistry(
    migration.registry,
  );
  const registryChanged = nextRegistryContent !== registryFile.content;
  if (
    !registryChanged &&
    !migration.creates.length &&
    !migration.writes.length
  ) {
    return;
  }

  const createdPaths: string[] = [];
  const writtenPromptContents: PromptContentWrite[] = [];
  try {
    for (const file of migration.creates) {
      await storage.createText(file.path, file.content, {
        createParents: true,
      });
      createdPaths.push(file.path);
    }
    for (const file of migration.writes) {
      await storage.writeText(file.path, file.next, {
        expectedContent: file.previous,
      });
      writtenPromptContents.push(file);
    }
    if (registryChanged) {
      await storage.writeText(
        PROMPT_LIBRARY_REGISTRY_PATH,
        nextRegistryContent,
        {
          expectedContent: registryFile.content,
        },
      );
    }
  } catch (error) {
    await Promise.all(
      writtenPromptContents
        .slice()
        .reverse()
        .map((file) =>
          storage
            .writeText(file.path, file.previous, {
              expectedContent: file.next,
            })
            .catch(() => undefined),
        ),
    );
    await Promise.all(
      createdPaths.map((path) =>
        storage.remove(path, { permanent: true }).catch(() => false),
      ),
    );
    throw error;
  }

  await Promise.all(
    migration.removePaths
      .filter((path) => !migration.creates.some((file) => file.path === path))
      .map((path) =>
        storage.remove(path, { permanent: true }).catch(() => false),
      ),
  );
}

async function ensurePromptLibrary(storage: WorkbenchStorage): Promise<void> {
  const [registryInfo] = await storage.stat([PROMPT_LIBRARY_REGISTRY_PATH]);
  if (registryInfo?.exists) {
    await ensureNovelWorkbenchPromptInstallation(
      storage,
      await storage.readText(PROMPT_LIBRARY_REGISTRY_PATH),
    );
    return;
  }
  const files = buildInitializationFiles();
  for (const file of files) {
    await ensureTextFile(storage, file.path, file.content);
  }
}

async function loadFromRegistry(
  storage: WorkbenchStorage,
  registryFile: WorkbenchTextFile,
): Promise<LoadedPromptLibrary> {
  const registry = parsePromptLibraryRegistry(registryFile.content);
  const promptFiles = await Promise.all(
    registry.prompts.map((prompt) => storage.readText(prompt.contentPath)),
  );
  const contentByInstanceId = new Map(
    registry.prompts.map((prompt, index) => [
      prompt.instanceId,
      promptFiles[index]?.content ?? "",
    ]),
  );
  return Object.freeze({
    model: registryToPromptLibraryModel(registry, contentByInstanceId),
    registryContent: registryFile.content,
    contentByInstanceId,
  });
}

export function createNovelPromptLibraryRepository(
  storage: WorkbenchStorage,
): NovelPromptLibraryRepository {
  const repository: NovelPromptLibraryRepository = {
    async load() {
      if (!storage.isAvailable) {
        throw new Error("提示词存储仅在 MyNovelStudio 桌面端可用");
      }
      await ensurePromptLibrary(storage);
      return loadFromRegistry(
        storage,
        await storage.readText(PROMPT_LIBRARY_REGISTRY_PATH),
      );
    },

    async save(current, model) {
      const nextRegistry = modelToRegistry(model);
      const nextRegistryContent = serializePromptLibraryRegistry(
        parsePromptLibraryRegistry(
          serializePromptLibraryRegistry(nextRegistry),
        ),
      );
      const currentPrompts = new Map(
        current.model.prompts.map((prompt) => [prompt.instanceId, prompt]),
      );
      const createdPaths: string[] = [];
      const nextContents = new Map(current.contentByInstanceId);

      for (const prompt of model.prompts) {
        const path = promptContentPath(prompt);
        const currentPrompt = currentPrompts.get(prompt.instanceId);
        if (!currentPrompt) {
          await storage.createText(path, prompt.content, {
            createParents: true,
          });
          createdPaths.push(path);
          nextContents.set(prompt.instanceId, prompt.content);
          continue;
        }
        const previousContent = current.contentByInstanceId.get(
          prompt.instanceId,
        );
        if (previousContent !== prompt.content) {
          await storage.writeText(path, prompt.content, {
            expectedContent: previousContent,
          });
          nextContents.set(prompt.instanceId, prompt.content);
        }
      }

      let registryContent = current.registryContent;
      try {
        if (nextRegistryContent !== current.registryContent) {
          const written = await storage.writeText(
            PROMPT_LIBRARY_REGISTRY_PATH,
            nextRegistryContent,
            { expectedContent: current.registryContent },
          );
          registryContent = written.content;
        }
      } catch (error) {
        await Promise.all(
          createdPaths.map((path) =>
            storage.remove(path, { permanent: true }).catch(() => false),
          ),
        );
        throw error;
      }

      const normalizedRegistry = parsePromptLibraryRegistry(registryContent);
      return Object.freeze({
        model: registryToPromptLibraryModel(normalizedRegistry, nextContents),
        registryContent,
        contentByInstanceId: nextContents,
      });
    },
  };
  return Object.freeze(repository);
}
