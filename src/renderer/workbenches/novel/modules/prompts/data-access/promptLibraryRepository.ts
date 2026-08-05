import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import { createDefaultPromptLibraryModel } from "../business/promptLibraryDefaults";
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

async function ensurePromptLibrary(storage: WorkbenchStorage): Promise<void> {
  const [registryInfo] = await storage.stat([PROMPT_LIBRARY_REGISTRY_PATH]);
  if (registryInfo?.exists) return;
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
        throw new Error("提示词存储仅在 MyAgents 桌面端可用");
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
