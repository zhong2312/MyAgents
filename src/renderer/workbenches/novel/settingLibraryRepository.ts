import {
  ensureWorkbenchTextFile,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import { parseFactionLibrary } from "./factionLibrarySchema";
import { parseLocationLibraryIndex } from "./locationLibrarySchema";
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
  /** 删除已落盘设定页面：先移除 settings.json 登记，再删除正文与词条文件。 */
  deleteSettingPage(
    library: LoadedSettingLibrary,
    instance: SettingInstance,
  ): Promise<LoadedSettingLibrary>;
  /**
   * 更新设定页面状态（draft / completed）。
   * completed 目前由作者显式标记，表示“该页已可作为事实引用”。
   */
  updateSettingStatus(
    library: LoadedSettingLibrary,
    instanceId: string,
    status: SettingInstance["status"],
  ): Promise<LoadedSettingLibrary>;
  /**
   * 删除空间节点（硬删除）。
   * 被下级节点、已落盘设定、地点库或势力地盘引用时抛错阻止。
   */
  deleteSpatialNode(
    library: LoadedSettingLibrary,
    nodeId: string,
  ): Promise<LoadedSettingLibrary>;
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

/**
 * 返回阻止删除空间节点的原因列表；空数组表示可以删除。
 * 检查：下级节点、已落盘设定、地点库归属、势力地盘引用。
 */
export function findSpatialNodeDeleteBlockers(
  library: LoadedSettingLibrary,
  nodeId: string,
  locationContent: string | null,
  factionContent: string | null,
): readonly string[] {
  const blockers: string[] = [];
  const hasChildren = library.spatialTree.nodes.some(
    (node) => node.parentId === nodeId,
  );
  if (hasChildren) {
    blockers.push("该节点仍包含下级空间节点，请先移动或删除下级节点");
  }
  const materialized = library.settingsIndex.settings.filter(
    (setting) => setting.nodeId === nodeId,
  );
  if (materialized.length > 0) {
    blockers.push(
      `该节点仍有 ${materialized.length} 个已落盘设定页面，请先删除这些页面`,
    );
  }
  if (locationContent !== null) {
    try {
      const locationIndex = parseLocationLibraryIndex(locationContent);
      const referenced = locationIndex.locations.filter(
        (location) => location.nodeId === nodeId,
      );
      if (referenced.length > 0) {
        blockers.push(
          `地点库仍有 ${referenced.length} 个地点归属该节点（如“${referenced[0].name}”），请先转移或删除`,
        );
      }
    } catch {
      // 地点文件损坏时不额外阻止删除，避免设定库被其它库拖死
    }
  }
  if (factionContent !== null) {
    try {
      const factionLibrary = parseFactionLibrary(factionContent);
      const referenced = factionLibrary.factions.filter((faction) =>
        faction.territories.some(
          (territory) => territory.worldNodeId === nodeId,
        ),
      );
      if (referenced.length > 0) {
        blockers.push(
          `势力库仍有 ${referenced.length} 个势力把该节点作为地盘（如“${referenced[0].name}”），请先在势力模块解除关联`,
        );
      }
    } catch {
      // 同上：势力文件损坏不阻止删除
    }
  }
  if (library.spatialTree.nodes.length <= 1) {
    blockers.push("空间树必须至少保留一个节点（世界根）");
  }
  return blockers;
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
          ensureWorkbenchTextFile(storage, file.path, file.content),
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
        templateVersion: template.version,
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
      const templateVersion = input.templateId
        ? library.meta.settingTemplates.find(
            (template) => template.id === input.templateId,
          )?.version
        : undefined;
      const paths = pagePaths(input.nodeId, input.id);
      const instance: SettingInstance = {
        id: input.id,
        nodeId: input.nodeId,
        templateId: input.templateId ?? null,
        templateVersion,
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

    async deleteSettingPage(library, instance) {
      const nextIndex: SettingLibrarySettingsIndex = {
        ...library.settingsIndex,
        settings: library.settingsIndex.settings.filter(
          (setting) => setting.id !== instance.id,
        ),
      };
      const nextLibrary = await repository.saveSettingsIndex(library, nextIndex);
      // 先写索引、后删文件：索引成功而文件残留只是孤儿文件（无害）；
      // 反过来会导致索引仍引用已删除文件，加载页面时失败。
      await Promise.all([
        storage.remove(instance.pagePath, { permanent: true }).catch(() => false),
        storage
          .remove(instance.entriesPath, { permanent: true })
          .catch(() => false),
      ]);
      return nextLibrary;
    },

    async updateSettingStatus(library, instanceId, status) {
      const exists = library.settingsIndex.settings.some(
        (setting) => setting.id === instanceId,
      );
      if (!exists) {
        throw new Error(`设定页面不存在：${instanceId}`);
      }
      const nextIndex: SettingLibrarySettingsIndex = {
        ...library.settingsIndex,
        settings: library.settingsIndex.settings.map((setting) =>
          setting.id === instanceId ? { ...setting, status } : setting,
        ),
      };
      return repository.saveSettingsIndex(library, nextIndex);
    },

    async deleteSpatialNode(library, nodeId) {
      const node = library.spatialTree.nodes.find((item) => item.id === nodeId);
      if (!node) {
        throw new Error(`空间节点不存在：${nodeId}`);
      }
      const [locationFile, factionFile] = await Promise.all([
        storage.readText("world/locations/index.json").catch(() => null),
        storage.readText("world/factions/index.json").catch(() => null),
      ]);
      const blockers = findSpatialNodeDeleteBlockers(
        library,
        nodeId,
        locationFile?.content ?? null,
        factionFile?.content ?? null,
      );
      if (blockers.length > 0) {
        throw new Error(`无法删除空间节点“${node.name}”：${blockers.join("；")}`);
      }
      const nextTree: SettingLibrarySpatialTree = {
        ...library.spatialTree,
        nodes: library.spatialTree.nodes.filter((item) => item.id !== nodeId),
      };
      return repository.saveSpatialTree(library, nextTree);
    },
  };
  return Object.freeze(repository);
}
