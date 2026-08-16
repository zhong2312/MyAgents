import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  parseCharacterLibraryIndex,
  parseCharacterRecordFile,
  type CharacterIndexEntry,
} from "./modules/characters/entities/characterLibrarySchema";
import { createNovelFactionLibraryRepository } from "./modules/factions/data-access/factionLibraryRepository";
import type { FactionRecord } from "./modules/factions/entities/factionLibrarySchema";
import { createNovelInspirationRepository } from "./inspirationRepository";
import type { InspirationItem } from "./modules/inspiration/entities/inspirationSchema";
import type {
  NarrativeChapterPlan,
  NarrativeDirectory,
  PlotLine,
} from "./narrativeEngineeringSchema";
import type { LoadedNovelChapter, LoadedNovelProject } from "./repository";
import {
  parseSettingLibrarySettingsIndex,
  parseSettingLibrarySpatialTree,
  type SettingInstance,
  type SpatialNode,
} from "./settingLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import type { TimelineLibrary } from "./modules/timeline/entities/timelineLibrarySchema";

export type FullGenerationContextReadMode = "quick" | "agent";

export interface FullGenerationQuickContextSelection {
  readonly settingIds: readonly string[];
  readonly includeTimeline: boolean;
  readonly narrativeLineIds: readonly string[];
  readonly narrativeDirectoryIds: readonly string[];
  readonly narrativeChapterIds: readonly string[];
  readonly characterIds: readonly string[];
  readonly previousChapterCount: number;
  readonly inspirationIds: readonly string[];
  readonly factionIds: readonly string[];
}

export type FullGenerationQuickContextIdField = Exclude<
  keyof FullGenerationQuickContextSelection,
  "includeTimeline" | "previousChapterCount"
>;

export interface FullGenerationQuickContextCatalog {
  readonly settingNodes: readonly SpatialNode[];
  readonly settings: readonly SettingInstance[];
  readonly timeline: TimelineLibrary | null;
  readonly narrativeLines: readonly PlotLine[];
  readonly narrativeDirectories: readonly NarrativeDirectory[];
  readonly narrativeChapters: readonly NarrativeChapterPlan[];
  readonly characters: readonly CharacterIndexEntry[];
  readonly previousChapters: readonly LoadedNovelChapter[];
  readonly inspirations: readonly InspirationItem[];
  readonly factions: readonly FactionRecord[];
  readonly issues: readonly string[];
}

export const FULL_GENERATION_QUICK_CONTEXT_CHARACTER_LIMIT = 160_000;

const EMPTY_CATALOG: FullGenerationQuickContextCatalog = Object.freeze({
  settingNodes: Object.freeze([]),
  settings: Object.freeze([]),
  timeline: null,
  narrativeLines: Object.freeze([]),
  narrativeDirectories: Object.freeze([]),
  narrativeChapters: Object.freeze([]),
  characters: Object.freeze([]),
  previousChapters: Object.freeze([]),
  inspirations: Object.freeze([]),
  factions: Object.freeze([]),
  issues: Object.freeze([]),
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(
  storage: WorkbenchStorage,
  path: string,
): Promise<boolean> {
  const [entry] = await storage.stat([path]);
  return Boolean(entry?.exists && entry.kind === "file");
}

export function createFullGenerationQuickContextSelection(
  previousChapterCount = 0,
): FullGenerationQuickContextSelection {
  return Object.freeze({
    settingIds: Object.freeze([]),
    includeTimeline: false,
    narrativeLineIds: Object.freeze([]),
    narrativeDirectoryIds: Object.freeze([]),
    narrativeChapterIds: Object.freeze([]),
    characterIds: Object.freeze([]),
    previousChapterCount: Math.max(
      0,
      Math.min(5, Math.round(previousChapterCount)),
    ),
    inspirationIds: Object.freeze([]),
    factionIds: Object.freeze([]),
  });
}

export function toggleFullGenerationQuickContextId(
  selection: FullGenerationQuickContextSelection,
  field: FullGenerationQuickContextIdField,
  id: string,
): FullGenerationQuickContextSelection {
  const current = selection[field];
  const next = current.includes(id)
    ? current.filter((item) => item !== id)
    : [...current, id];
  return Object.freeze({ ...selection, [field]: Object.freeze(next) });
}

export function replaceFullGenerationQuickContextIds(
  selection: FullGenerationQuickContextSelection,
  field: FullGenerationQuickContextIdField,
  ids: readonly string[],
): FullGenerationQuickContextSelection {
  return Object.freeze({
    ...selection,
    [field]: Object.freeze(Array.from(new Set(ids))),
  });
}

export function countFullGenerationQuickContextItems(
  selection: FullGenerationQuickContextSelection,
): number {
  return (
    selection.settingIds.length +
    (selection.includeTimeline ? 1 : 0) +
    selection.narrativeLineIds.length +
    selection.narrativeDirectoryIds.length +
    selection.narrativeChapterIds.length +
    selection.characterIds.length +
    selection.previousChapterCount +
    selection.inspirationIds.length +
    selection.factionIds.length
  );
}

function descendantNodeIds(
  nodes: readonly SpatialNode[],
  nodeId: string,
): ReadonlySet<string> {
  const result = new Set([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && result.has(node.parentId) && !result.has(node.id)) {
        result.add(node.id);
        changed = true;
      }
    }
  }
  return result;
}

export function getFullGenerationSettingIdsForNode(
  catalog: Pick<FullGenerationQuickContextCatalog, "settingNodes" | "settings">,
  nodeId: string,
): readonly string[] {
  const nodeIds = descendantNodeIds(catalog.settingNodes, nodeId);
  return catalog.settings
    .filter((setting) => nodeIds.has(setting.nodeId))
    .map((setting) => setting.id);
}

function previousChapters(
  project: LoadedNovelProject,
  chapterId: string,
): readonly LoadedNovelChapter[] {
  const currentIndex = project.chapters.findIndex(
    (chapter) => chapter.id === chapterId,
  );
  if (currentIndex <= 0) return Object.freeze([]);
  return Object.freeze(
    project.chapters.slice(Math.max(0, currentIndex - 5), currentIndex),
  );
}

export async function loadFullGenerationQuickContextCatalog(input: {
  readonly storage: WorkbenchStorage;
  readonly project: LoadedNovelProject;
  readonly chapterId: string;
}): Promise<FullGenerationQuickContextCatalog> {
  if (!input.storage.isAvailable) return EMPTY_CATALOG;

  const issues: string[] = [];
  const loadSettings = async () => {
    try {
      const paths = [
        "world/setting-library/spatial-tree.json",
        "world/setting-library/settings.json",
      ] as const;
      if (!(await fileExists(input.storage, paths[0]))) {
        return {
          nodes: [] as readonly SpatialNode[],
          settings: [] as readonly SettingInstance[],
        };
      }
      const [treeFile, settingsFile] = await Promise.all(
        paths.map((path) => input.storage.readText(path)),
      );
      return {
        nodes: parseSettingLibrarySpatialTree(treeFile.content).nodes,
        settings: parseSettingLibrarySettingsIndex(settingsFile.content)
          .settings,
      };
    } catch (error) {
      issues.push(`世界架构：${errorText(error)}`);
      return {
        nodes: [] as readonly SpatialNode[],
        settings: [] as readonly SettingInstance[],
      };
    }
  };
  const loadCharacters = async () => {
    try {
      if (!(await fileExists(input.storage, "characters/index.json"))) {
        return [] as readonly CharacterIndexEntry[];
      }
      const file = await input.storage.readText("characters/index.json");
      return parseCharacterLibraryIndex(file.content).characters;
    } catch (error) {
      issues.push(`人物库：${errorText(error)}`);
      return [] as readonly CharacterIndexEntry[];
    }
  };
  const loadTimeline = async () => {
    try {
      if (!(await fileExists(input.storage, "timeline/index.json")))
        return null;
      return (await createNovelTimelineLibraryRepository(input.storage).load())
        .library;
    } catch (error) {
      issues.push(`时间线：${errorText(error)}`);
      return null;
    }
  };
  const loadInspirations = async () => {
    try {
      if (!(await fileExists(input.storage, "inspiration/index.json"))) {
        return [] as readonly InspirationItem[];
      }
      return (await createNovelInspirationRepository(input.storage).load())
        .library.items;
    } catch (error) {
      issues.push(`灵感：${errorText(error)}`);
      return [] as readonly InspirationItem[];
    }
  };
  const loadFactions = async () => {
    try {
      if (!(await fileExists(input.storage, "world/factions/index.json"))) {
        return [] as readonly FactionRecord[];
      }
      return (await createNovelFactionLibraryRepository(input.storage).load())
        .library.factions;
    } catch (error) {
      issues.push(`势力：${errorText(error)}`);
      return [] as readonly FactionRecord[];
    }
  };

  const [settingData, characters, timeline, inspirations, factions] =
    await Promise.all([
      loadSettings(),
      loadCharacters(),
      loadTimeline(),
      loadInspirations(),
      loadFactions(),
    ]);

  return Object.freeze({
    settingNodes: Object.freeze([...settingData.nodes]),
    settings: Object.freeze([...settingData.settings]),
    timeline,
    narrativeLines: Object.freeze([...input.project.narrative.library.lines]),
    narrativeDirectories: Object.freeze([
      ...input.project.narrative.library.directories,
    ]),
    narrativeChapters: Object.freeze([
      ...input.project.narrative.library.chapters,
    ]),
    characters: Object.freeze([...characters]),
    previousChapters: previousChapters(input.project, input.chapterId),
    inspirations: Object.freeze([...inspirations]),
    factions: Object.freeze([...factions]),
    issues: Object.freeze([...issues]),
  });
}

function settingNodePath(
  nodes: readonly SpatialNode[],
  nodeId: string,
): string {
  const parts: string[] = [];
  const visited = new Set<string>();
  let current = nodes.find((node) => node.id === nodeId);
  while (current && !visited.has(current.id)) {
    parts.unshift(current.name);
    visited.add(current.id);
    current = current.parentId
      ? nodes.find((node) => node.id === current?.parentId)
      : undefined;
  }
  return parts.join(" / ");
}

function serializeSelected<T extends { readonly id: string }>(
  values: readonly T[],
  selectedIds: readonly string[],
): string {
  const selected = new Set(selectedIds);
  return JSON.stringify(
    values.filter((value) => selected.has(value.id)),
    null,
    2,
  );
}

export async function buildFullGenerationQuickContext(input: {
  readonly storage: WorkbenchStorage;
  readonly catalog: FullGenerationQuickContextCatalog;
  readonly selection: FullGenerationQuickContextSelection;
}): Promise<string> {
  const sections: string[] = [];
  const selectedSettings = new Set(input.selection.settingIds);
  const settingPages = input.catalog.settings.filter((setting) =>
    selectedSettings.has(setting.id),
  );
  if (settingPages.length) {
    const pages = await Promise.all(
      settingPages.map(async (setting) => {
        const file = await input.storage.readText(setting.pagePath);
        const path = settingNodePath(
          input.catalog.settingNodes,
          setting.nodeId,
        );
        return `### ${path ? `${path} / ` : ""}${setting.name}\n${file.content.trim()}`;
      }),
    );
    sections.push(`## 世界架构\n${pages.join("\n\n")}`);
  }

  if (input.selection.includeTimeline && input.catalog.timeline) {
    sections.push(
      `## 时间线\n${JSON.stringify(input.catalog.timeline, null, 2)}`,
    );
  }

  const narrativeParts = [
    input.selection.narrativeLineIds.length
      ? `### 线路\n${serializeSelected(input.catalog.narrativeLines, input.selection.narrativeLineIds)}`
      : "",
    input.selection.narrativeDirectoryIds.length
      ? `### 大纲\n${serializeSelected(input.catalog.narrativeDirectories, input.selection.narrativeDirectoryIds)}`
      : "",
    input.selection.narrativeChapterIds.length
      ? `### 章节\n${serializeSelected(input.catalog.narrativeChapters, input.selection.narrativeChapterIds)}`
      : "",
  ].filter(Boolean);
  if (narrativeParts.length) {
    sections.push(`## 剧情工程\n${narrativeParts.join("\n\n")}`);
  }

  const selectedCharacters = new Set(input.selection.characterIds);
  const characterEntries = input.catalog.characters.filter((character) =>
    selectedCharacters.has(character.id),
  );
  if (characterEntries.length) {
    const records = await Promise.all(
      characterEntries.map(async (entry) => {
        const file = await input.storage.readText(entry.recordPath);
        return parseCharacterRecordFile(entry.recordPath, file.content);
      }),
    );
    sections.push(`## 人物库\n${JSON.stringify(records, null, 2)}`);
  }

  const previousChapterCount = Math.min(
    5,
    input.catalog.previousChapters.length,
    Math.max(0, Math.round(input.selection.previousChapterCount)),
  );
  if (previousChapterCount) {
    const chapters =
      input.catalog.previousChapters.slice(-previousChapterCount);
    sections.push(
      `## 前文\n${chapters
        .map(
          (chapter) =>
            `### 第 ${chapter.displayNumber} 章 · ${chapter.title}\n${chapter.content.trim()}`,
        )
        .join("\n\n")}`,
    );
  }

  if (input.selection.inspirationIds.length) {
    sections.push(
      `## 灵感\n${serializeSelected(input.catalog.inspirations, input.selection.inspirationIds)}`,
    );
  }

  if (input.selection.factionIds.length) {
    sections.push(
      `## 势力\n${serializeSelected(input.catalog.factions, input.selection.factionIds)}`,
    );
  }

  const body = sections.length
    ? sections.join("\n\n")
    : "作者没有额外选择项目资料；仅使用当前章节计划、当前正文和作者指令。";
  const context = [
    "【快速模式资料快照】",
    "以下资料由作者明确选择，并已一次性注入本轮上下文。不得调用工具；未选择的资料不代表不存在，不得自行补造其中的事实。",
    body,
  ].join("\n\n");
  if (context.length > FULL_GENERATION_QUICK_CONTEXT_CHARACTER_LIMIT) {
    throw new Error(
      `快速模式已选资料共 ${context.length.toLocaleString()} 个字符，超过 ${FULL_GENERATION_QUICK_CONTEXT_CHARACTER_LIMIT.toLocaleString()} 字符上限；请减少资料后重试。`,
    );
  }
  return context;
}
