import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createDefaultSettingLibraryMeta,
  createDefaultSettingLibraryTree,
  createEmptySettingLibraryIndex,
  SETTING_LIBRARY_SCHEMA_VERSION,
} from "./settingLibraryDefaults";
import {
  parseSettingEntriesFile,
  parseSettingLibraryMeta,
  parseSettingLibrarySettingsIndex,
  parseSettingLibrarySpatialTree,
  serializeSettingLibraryFile,
  type SettingEntriesFile,
  type SettingEntry,
  type SettingInstance,
  type SettingLibraryMeta,
  type SettingLibrarySettingsIndex,
  type SettingLibrarySpatialTree,
  type SettingTemplate,
  type SpatialNode,
} from "./settingLibrarySchema";

export const SETTING_LIBRARY_PATHS = Object.freeze({
  meta: "world/setting-library/meta.json",
  spatialTree: "world/setting-library/spatial-tree.json",
  settings: "world/setting-library/settings.json",
});

export interface LoadedSettingLibrary {
  readonly meta: SettingLibraryMeta;
  readonly metaContent: string;
  readonly spatialTree: SettingLibrarySpatialTree;
  readonly spatialTreeContent: string;
  readonly settingsIndex: SettingLibrarySettingsIndex;
  readonly settingsIndexContent: string;
}

export type SettingPageReference =
  | {
      readonly kind: "virtual";
      readonly nodeId: string;
      readonly template: SettingTemplate;
    }
  | {
      readonly kind: "instance";
      readonly instance: SettingInstance;
    };

export interface LoadedSettingPage {
  readonly reference: SettingPageReference;
  readonly content: string;
  readonly entries: readonly SettingEntry[];
  readonly entriesContent: string | null;
}

export interface SaveSettingPageResult {
  readonly library: LoadedSettingLibrary;
  readonly page: LoadedSettingPage;
}

export interface NovelSettingLibraryRepository {
  load(projectTitle: string): Promise<LoadedSettingLibrary>;
  loadPage(reference: SettingPageReference): Promise<LoadedSettingPage>;
  saveMeta(
    library: LoadedSettingLibrary,
    meta: SettingLibraryMeta,
  ): Promise<LoadedSettingLibrary>;
  saveSpatialTree(
    library: LoadedSettingLibrary,
    spatialTree: SettingLibrarySpatialTree,
  ): Promise<LoadedSettingLibrary>;
  saveSettingsIndex(
    library: LoadedSettingLibrary,
    settingsIndex: SettingLibrarySettingsIndex,
  ): Promise<LoadedSettingLibrary>;
  savePage(
    library: LoadedSettingLibrary,
    page: LoadedSettingPage,
    content: string,
  ): Promise<SaveSettingPageResult>;
  saveEntries(
    page: LoadedSettingPage,
    entries: readonly SettingEntry[],
  ): Promise<LoadedSettingPage>;
  createCustomSetting(
    library: LoadedSettingLibrary,
    input: {
      readonly id: string;
      readonly nodeId: string;
      readonly name: string;
      readonly group: string;
      readonly skeleton: string;
      readonly templateId?: string | null;
    },
  ): Promise<SaveSettingPageResult>;
}

function serializeMeta(meta: SettingLibraryMeta): string {
  return serializeSettingLibraryFile(meta);
}

function serializeTree(tree: SettingLibrarySpatialTree): string {
  return serializeSettingLibraryFile(tree);
}

function serializeSettings(index: SettingLibrarySettingsIndex): string {
  return serializeSettingLibraryFile(index);
}

function emptyEntriesContent(): string {
  return serializeSettingLibraryFile({
    schemaVersion: SETTING_LIBRARY_SCHEMA_VERSION,
    entries: [],
  });
}

export function createSettingLibraryInitializationFiles(
  projectTitle: string,
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: SETTING_LIBRARY_PATHS.meta,
      content: serializeMeta(createDefaultSettingLibraryMeta()),
    },
    {
      path: SETTING_LIBRARY_PATHS.spatialTree,
      content: serializeTree(createDefaultSettingLibraryTree(projectTitle)),
    },
    {
      path: SETTING_LIBRARY_PATHS.settings,
      content: serializeSettings(createEmptySettingLibraryIndex()),
    },
  ];
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

function replaceLibrary(
  library: LoadedSettingLibrary,
  patch: Partial<LoadedSettingLibrary>,
): LoadedSettingLibrary {
  return Object.freeze({ ...library, ...patch });
}

export function validateSettingLibraryReferences(
  library: LoadedSettingLibrary,
): void {
  const typeIds = new Set(library.meta.levelTypes.map((type) => type.id));
  const templateIds = new Set(
    library.meta.settingTemplates.map((template) => template.id),
  );
  const nodeIds = new Set(library.spatialTree.nodes.map((node) => node.id));
  for (const node of library.spatialTree.nodes) {
    if (!typeIds.has(node.typeId)) {
      throw new Error(
        `空间节点“${node.name}”关联了不存在的层级类型：${node.typeId}`,
      );
    }
  }
  for (const setting of library.settingsIndex.settings) {
    if (!nodeIds.has(setting.nodeId)) {
      throw new Error(
        `设定“${setting.name}”关联了不存在的空间节点：${setting.nodeId}`,
      );
    }
    if (setting.templateId && !templateIds.has(setting.templateId)) {
      throw new Error(
        `设定“${setting.name}”关联了不存在的设定模板：${setting.templateId}`,
      );
    }
  }
}

function pagePaths(nodeId: string, settingId: string) {
  const base = `world/setting-library`;
  return {
    pagePath: `${base}/pages/${nodeId}/${settingId}.md`,
    entriesPath: `${base}/entries/${nodeId}/${settingId}.json`,
  } as const;
}

async function createMaterializedFiles(
  storage: WorkbenchStorage,
  instance: SettingInstance,
  content: string,
): Promise<void> {
  await storage.createText(instance.pagePath, content, { createParents: true });
  try {
    await storage.createText(instance.entriesPath, emptyEntriesContent(), {
      createParents: true,
    });
  } catch (error) {
    await storage
      .remove(instance.pagePath, { permanent: true })
      .catch(() => false);
    throw error;
  }
}

function withSettingInstance(
  library: LoadedSettingLibrary,
  instance: SettingInstance,
): SettingLibrarySettingsIndex {
  return {
    ...library.settingsIndex,
    settings: [...library.settingsIndex.settings, instance],
  };
}

export function getSpatialChildren(
  tree: SettingLibrarySpatialTree,
  parentId: string | null,
): readonly SpatialNode[] {
  return tree.nodes
    .filter((node) => node.parentId === parentId)
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.name.localeCompare(right.name, "zh-CN"),
    );
}

export function getNodeSettingReferences(
  library: LoadedSettingLibrary,
  nodeId: string,
): readonly SettingPageReference[] {
  const node = library.spatialTree.nodes.find((item) => item.id === nodeId);
  if (!node) return [];
  const instances = library.settingsIndex.settings.filter(
    (setting) => setting.nodeId === nodeId,
  );
  const materializedByTemplate = new Map(
    instances
      .filter((setting) => setting.templateId !== null)
      .map((setting) => [setting.templateId, setting] as const),
  );
  const profile = library.meta.profiles.find(
    (item) => item.levelTypeId === node.typeId,
  );
  const defaultReferences = (profile?.templateIds ?? []).flatMap(
    (templateId): SettingPageReference[] => {
      const materialized = materializedByTemplate.get(templateId);
      if (materialized) return [{ kind: "instance", instance: materialized }];
      const template = library.meta.settingTemplates.find(
        (item) => item.id === templateId && !item.archived,
      );
      return template ? [{ kind: "virtual", nodeId, template }] : [];
    },
  );
  const defaultInstanceIds = new Set(
    defaultReferences.flatMap((reference) =>
      reference.kind === "instance" ? [reference.instance.id] : [],
    ),
  );
  const retainedInstances = instances
    .filter((instance) => !defaultInstanceIds.has(instance.id))
    .map((instance): SettingPageReference => ({ kind: "instance", instance }));
  return [...defaultReferences, ...retainedInstances];
}

export function settingReferenceId(reference: SettingPageReference): string {
  return reference.kind === "instance"
    ? reference.instance.id
    : `virtual:${reference.nodeId}:${reference.template.id}`;
}

export function createNovelSettingLibraryRepository(
  storage: WorkbenchStorage,
): NovelSettingLibraryRepository {
  const repository: NovelSettingLibraryRepository = {
    async load(projectTitle) {
      if (!storage.isAvailable) {
        throw new Error("小说设定库存储仅在 MyAgents 桌面端可用");
      }
      const initialFiles =
        createSettingLibraryInitializationFiles(projectTitle);
      const [metaFile, treeFile, settingsFile] = await Promise.all(
        initialFiles.map((file) =>
          ensureTextFile(storage, file.path, file.content),
        ),
      );
      const library: LoadedSettingLibrary = Object.freeze({
        meta: parseSettingLibraryMeta(metaFile.content),
        metaContent: metaFile.content,
        spatialTree: parseSettingLibrarySpatialTree(treeFile.content),
        spatialTreeContent: treeFile.content,
        settingsIndex: parseSettingLibrarySettingsIndex(settingsFile.content),
        settingsIndexContent: settingsFile.content,
      });
      validateSettingLibraryReferences(library);
      return library;
    },

    async loadPage(reference) {
      if (reference.kind === "virtual") {
        return Object.freeze({
          reference,
          content: reference.template.skeleton,
          entries: Object.freeze([]),
          entriesContent: null,
        });
      }
      const [pageFile, entriesFile] = await Promise.all([
        storage.readText(reference.instance.pagePath),
        storage.readText(reference.instance.entriesPath),
      ]);
      const entries = parseSettingEntriesFile(entriesFile.content);
      return Object.freeze({
        reference,
        content: pageFile.content,
        entries: Object.freeze([...entries.entries]),
        entriesContent: entriesFile.content,
      });
    },

    async saveMeta(library, meta) {
      const content = serializeMeta(meta);
      const file = await storage.writeText(
        SETTING_LIBRARY_PATHS.meta,
        content,
        {
          expectedContent: library.metaContent,
        },
      );
      const next = replaceLibrary(library, {
        meta: parseSettingLibraryMeta(file.content),
        metaContent: file.content,
      });
      validateSettingLibraryReferences(next);
      return next;
    },

    async saveSpatialTree(library, spatialTree) {
      const content = serializeTree(spatialTree);
      const file = await storage.writeText(
        SETTING_LIBRARY_PATHS.spatialTree,
        content,
        { expectedContent: library.spatialTreeContent },
      );
      const next = replaceLibrary(library, {
        spatialTree: parseSettingLibrarySpatialTree(file.content),
        spatialTreeContent: file.content,
      });
      validateSettingLibraryReferences(next);
      return next;
    },

    async saveSettingsIndex(library, settingsIndex) {
      const content = serializeSettings(settingsIndex);
      const file = await storage.writeText(
        SETTING_LIBRARY_PATHS.settings,
        content,
        { expectedContent: library.settingsIndexContent },
      );
      const next = replaceLibrary(library, {
        settingsIndex: parseSettingLibrarySettingsIndex(file.content),
        settingsIndexContent: file.content,
      });
      validateSettingLibraryReferences(next);
      return next;
    },

    async savePage(library, page, content) {
      if (page.reference.kind === "instance") {
        await storage.writeText(page.reference.instance.pagePath, content, {
          expectedContent: page.content,
        });
        return {
          library,
          page: Object.freeze({ ...page, content }),
        };
      }

      const { nodeId, template } = page.reference;
      const id = `page-${nodeId}-${template.id}`;
      const paths = pagePaths(nodeId, id);
      const instance: SettingInstance = {
        id,
        nodeId,
        templateId: template.id,
        name: template.name,
        group: template.group,
        status: "draft",
        ...paths,
      };
      await createMaterializedFiles(storage, instance, content);
      try {
        const nextLibrary = await repository.saveSettingsIndex(
          library,
          withSettingInstance(library, instance),
        );
        const materializedReference: SettingPageReference = {
          kind: "instance",
          instance,
        };
        const materializedPage: LoadedSettingPage = Object.freeze({
          reference: materializedReference,
          content,
          entries: Object.freeze([]),
          entriesContent: emptyEntriesContent(),
        });
        return {
          library: nextLibrary,
          page: materializedPage,
        };
      } catch (error) {
        await Promise.all([
          storage
            .remove(instance.pagePath, { permanent: true })
            .catch(() => false),
          storage
            .remove(instance.entriesPath, { permanent: true })
            .catch(() => false),
        ]);
        throw error;
      }
    },

    async saveEntries(page, entries) {
      if (page.reference.kind !== "instance" || page.entriesContent === null) {
        throw new Error("保存词条前必须先将设定页面落盘");
      }
      const content = serializeSettingLibraryFile({
        schemaVersion: SETTING_LIBRARY_SCHEMA_VERSION,
        entries,
      } satisfies SettingEntriesFile);
      const file = await storage.writeText(
        page.reference.instance.entriesPath,
        content,
        { expectedContent: page.entriesContent },
      );
      const parsed = parseSettingEntriesFile(file.content);
      return Object.freeze({
        ...page,
        entries: Object.freeze([...parsed.entries]),
        entriesContent: file.content,
      });
    },

    async createCustomSetting(library, input) {
      const normalizedName = input.name.trim();
      const normalizedGroup = input.group.trim();
      if (!normalizedName || !normalizedGroup) {
        throw new Error("设定名称和分组不能为空");
      }
      if (
        library.settingsIndex.settings.some(
          (setting) => setting.id === input.id,
        )
      ) {
        throw new Error(`设定 id 已存在：${input.id}`);
      }
      const paths = pagePaths(input.nodeId, input.id);
      const instance: SettingInstance = {
        id: input.id,
        nodeId: input.nodeId,
        templateId: input.templateId ?? null,
        name: normalizedName,
        group: normalizedGroup,
        status: "draft",
        ...paths,
      };
      await createMaterializedFiles(storage, instance, input.skeleton);
      try {
        const nextLibrary = await repository.saveSettingsIndex(
          library,
          withSettingInstance(library, instance),
        );
        const customReference: SettingPageReference = {
          kind: "instance",
          instance,
        };
        const customPage: LoadedSettingPage = Object.freeze({
          reference: customReference,
          content: input.skeleton,
          entries: Object.freeze([]),
          entriesContent: emptyEntriesContent(),
        });
        return {
          library: nextLibrary,
          page: customPage,
        };
      } catch (error) {
        await Promise.all([
          storage
            .remove(instance.pagePath, { permanent: true })
            .catch(() => false),
          storage
            .remove(instance.entriesPath, { permanent: true })
            .catch(() => false),
        ]);
        throw error;
      }
    },
  };
  return Object.freeze(repository);
}
