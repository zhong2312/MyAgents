import type { WorkbenchProjection, WorkbenchProjectionRef, WorkbenchStorage } from "@/workbench-sdk";

import { parseCharacterLibraryIndex } from "../../characterLibrarySchema";
import { createNovelCharacterLibraryRepository } from "../../characterLibraryRepository";
import {
  FACTION_LIBRARY_PATH,
  parseFactionLibrary,
  type FactionLibrary,
  type FactionRecord,
} from "../../modules/factions/entities/factionLibrarySchema";
import { parseItemLibraryIndex } from "../../itemLibrarySchema";
import { ITEM_LIBRARY_PATHS } from "../../itemLibraryRepository";
import {
  LOCATION_LIBRARY_PATH,
  parseLocationLibraryIndex,
} from "../../locationLibrarySchema";
import { parseNovelChapterIndex } from "../../modules/project/entities/projectSchema";
import {
  parseSettingLibrarySpatialTree,
  type SpatialNode,
} from "../../settingLibrarySchema";
import {
  TIMELINE_LIBRARY_PATH,
  parseTimelineLibrary,
  type TimelineEvent,
  type TimelineLibrary,
} from "../../timelineLibrarySchema";

const MANUSCRIPT_INDEX_PATH = "manuscript/index.json";
const CULTIVATION_ECOLOGY_PATH = "world/cultivation-ecology.json";
const NARRATIVE_ENGINEERING_PATH = "narrative/index.json";

/**
 * 各设定库实体 ID 集合。文件缺失时对应集合为空（引用会因此被判定为悬空）；
 * 文件存在但解析失败时抛错，阻止保存，避免在数据损坏时静默写入更多坏引用。
 */
export interface CrossLibraryIdSets {
  readonly characters: ReadonlySet<string>;
  readonly factions: ReadonlySet<string>;
  readonly items: ReadonlySet<string>;
  readonly locations: ReadonlySet<string>;
  readonly chapters: ReadonlySet<string>;
  readonly spatialNodes: ReadonlySet<string>;
}

export function createEmptyCrossLibraryIdSets(): CrossLibraryIdSets {
  return {
    characters: new Set<string>(),
    factions: new Set<string>(),
    items: new Set<string>(),
    locations: new Set<string>(),
    chapters: new Set<string>(),
    spatialNodes: new Set<string>(),
  };
}

function idsOf<T>(values: readonly T[], pick: (value: T) => string): Set<string> {
  const ids = new Set<string>();
  values.forEach((value) => ids.add(pick(value)));
  return ids;
}

async function loadOptionalJson(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  const [info] = await storage.stat([path]);
  if (!info?.exists) return null;
  const file = await storage.readText(path);
  return file.content;
}

/** 并行加载全部库的 ID 集合；某个库文件损坏时抛错（与角色库修行引用校验行为一致）。 */
export async function loadCrossLibraryIdSets(
  storage: WorkbenchStorage,
): Promise<CrossLibraryIdSets> {
  const [charactersContent, factionsContent, itemsContent, locationsContent, chaptersContent, spatialContent] =
    await Promise.all([
      loadOptionalJson(storage, "characters/index.json"),
      loadOptionalJson(storage, FACTION_LIBRARY_PATH),
      loadOptionalJson(storage, ITEM_LIBRARY_PATHS.index),
      loadOptionalJson(storage, LOCATION_LIBRARY_PATH),
      loadOptionalJson(storage, MANUSCRIPT_INDEX_PATH),
      loadOptionalJson(storage, "world/setting-library/spatial-tree.json"),
    ]);

  let characters: ReadonlySet<string> = new Set<string>();
  let factions: ReadonlySet<string> = new Set<string>();
  let items: ReadonlySet<string> = new Set<string>();
  let locations: ReadonlySet<string> = new Set<string>();
  let chapters: ReadonlySet<string> = new Set<string>();
  let spatialNodes: ReadonlySet<string> = new Set<string>();

  if (charactersContent !== null) {
    characters = idsOf(
      parseCharacterLibraryIndex(charactersContent).characters,
      (character) => character.id,
    );
  }
  if (factionsContent !== null) {
    factions = idsOf(
      parseFactionLibrary(factionsContent).factions,
      (faction) => faction.id,
    );
  }
  if (itemsContent !== null) {
    items = idsOf(
      parseItemLibraryIndex(itemsContent).items,
      (item) => item.id,
    );
  }
  if (locationsContent !== null) {
    locations = idsOf(
      parseLocationLibraryIndex(locationsContent).locations,
      (location) => location.id,
    );
  }
  if (chaptersContent !== null) {
    chapters = idsOf(
      parseNovelChapterIndex(chaptersContent).chapters,
      (chapter) => chapter.id,
    );
  }
  if (spatialContent !== null) {
    spatialNodes = idsOf(
      parseSettingLibrarySpatialTree(spatialContent).nodes,
      (node: SpatialNode) => node.id,
    );
  }

  return {
    characters,
    factions,
    items,
    locations,
    chapters,
    spatialNodes,
  };
}

function missingIds(
  ids: readonly string[],
  available: ReadonlySet<string>,
): readonly string[] {
  return ids.filter((id) => !available.has(id));
}

function formatMissing(label: string, ids: readonly string[]): string {
  return `关联了不存在的${label}：${[...ids].join("、")}`;
}

/** 保存时间线前校验跨库引用（角色/地点/章节/势力/物品）。 */
export async function validateTimelineCrossReferences(
  storage: WorkbenchStorage,
  library: TimelineLibrary,
): Promise<void> {
  const available = await loadCrossLibraryIdSets(storage);
  for (const event of library.events) {
    const problems: string[] = [];
    const characterMissing = missingIds(
      event.characterIds,
      available.characters,
    );
    if (characterMissing.length > 0) {
      problems.push(formatMissing("角色", characterMissing));
    }
    const locationMissing = missingIds(event.locationIds, available.locations);
    if (locationMissing.length > 0) {
      problems.push(formatMissing("地点", locationMissing));
    }
    const chapterMissing = missingIds(event.chapterIds, available.chapters);
    if (chapterMissing.length > 0) {
      problems.push(formatMissing("正文章节", chapterMissing));
    }
    const factionMissing = missingIds(event.factionIds, available.factions);
    if (factionMissing.length > 0) {
      problems.push(formatMissing("势力", factionMissing));
    }
    const itemMissing = missingIds(event.itemIds, available.items);
    if (itemMissing.length > 0) {
      problems.push(formatMissing("物品", itemMissing));
    }
    event.stateChanges.forEach((change) => {
      const targetSet =
        change.entityType === "character"
          ? available.characters
          : change.entityType === "faction"
            ? available.factions
            : change.entityType === "item"
              ? available.items
              : available.locations;
      if (!targetSet.has(change.entityId)) {
        problems.push(
          `状态变化对象（${change.entityType}）：${change.entityId}`,
        );
      }
    });
    event.foreshadowings.forEach((foreshadowing) => {
      if (
        foreshadowing.plantedChapterId &&
        !available.chapters.has(foreshadowing.plantedChapterId)
      ) {
        problems.push(`伏笔“${foreshadowing.title}”的埋设章节不存在`);
      }
    });
    if (problems.length > 0) {
      throw new Error(`时间线事件“${event.title}”存在失效的关联：${problems.join("；")}`);
    }
  }
}

/** 保存势力库前校验跨库引用（成员角色/领地空间节点/资源物品/链接目标）。 */
export async function validateFactionCrossReferences(
  storage: WorkbenchStorage,
  library: FactionLibrary,
): Promise<void> {
  const available = await loadCrossLibraryIdSets(storage);
  for (const faction of library.factions) {
    const problems: string[] = [];
    faction.members.forEach((member) => {
      if (member.characterId && !available.characters.has(member.characterId)) {
        problems.push(`成员“${member.name}”关联了不存在的角色：${member.characterId}`);
      }
    });
    faction.territories.forEach((territory) => {
      if (
        territory.worldNodeId &&
        !available.spatialNodes.has(territory.worldNodeId)
      ) {
        problems.push(`领地“${territory.name}”关联了不存在的空间节点：${territory.worldNodeId}`);
      }
    });
    faction.resources.forEach((resource) => {
      if (resource.worldNodeId && !available.spatialNodes.has(resource.worldNodeId)) {
        problems.push(`资源“${resource.name}”关联了不存在的空间节点：${resource.worldNodeId}`);
      }
      if (resource.itemId && !available.items.has(resource.itemId)) {
        problems.push(`资源“${resource.name}”关联了不存在的物品：${resource.itemId}`);
      }
    });
    faction.rights.forEach((right) => {
      if (right.worldNodeId && !available.spatialNodes.has(right.worldNodeId)) {
        problems.push(`权限“${right.name}”关联了不存在的空间节点：${right.worldNodeId}`);
      }
    });
    faction.links.forEach((link) => {
      if (link.kind === "character" && link.targetId && !available.characters.has(link.targetId)) {
        problems.push(`链接“${link.label}”关联了不存在的角色：${link.targetId}`);
      }
      if (link.kind === "item" && link.targetId && !available.items.has(link.targetId)) {
        problems.push(`链接“${link.label}”关联了不存在的物品：${link.targetId}`);
      }
    });
    if (problems.length > 0) {
      throw new Error(`势力“${faction.name}”存在失效的关联：${problems.join("；")}`);
    }
  }
}

/** 反向引用命中描述。 */
export interface InboundReferenceHit {
  readonly library: string;
  readonly location: string;
}

function hit(library: string, location: string): InboundReferenceHit {
  return { library, location };
}

function projectionInboundHit(ref: WorkbenchProjectionRef): InboundReferenceHit {
  switch (ref.fromKind) {
    case "event":
      return hit("时间线", `时间线事件“${ref.fromId}”的${ref.field}`);
    case "faction":
      return hit("势力组织", `势力“${ref.fromId}”的${ref.field}`);
    case "narrativeLine":
      return hit("剧情工程", `线路“${ref.fromId}”的${ref.field}`);
    case "narrativeArc":
      return hit("剧情工程", `故事弧“${ref.fromId}”的${ref.field}`);
    case "narrativeChapter":
      return hit("剧情工程", `章节“${ref.fromId}”的${ref.field}`);
    default:
      return hit("领域投影", `${ref.fromKind}“${ref.fromId}”的${ref.field}`);
  }
}

function collectTimelineReferenceHits(
  events: readonly TimelineEvent[],
  kind: "character" | "faction" | "item" | "location",
  id: string,
): readonly InboundReferenceHit[] {
  const hits: InboundReferenceHit[] = [];
  for (const event of events) {
    const field =
      kind === "character"
        ? event.characterIds
        : kind === "faction"
          ? event.factionIds
          : kind === "item"
            ? event.itemIds
            : event.locationIds;
    if (field.includes(id)) {
      hits.push(
        hit("时间线", `时间线事件“${event.title}”的关联${kind === "character" ? "角色" : kind === "faction" ? "势力" : kind === "item" ? "物品" : "地点"}`),
      );
    }
    if (
      kind === "character" &&
      event.stateChanges.some(
        (change) => change.entityType === "character" && change.entityId === id,
      )
    ) {
      hits.push(hit("时间线", `时间线事件“${event.title}”的状态变化`));
    }
    if (
      kind === "faction" &&
      event.stateChanges.some(
        (change) => change.entityType === "faction" && change.entityId === id,
      )
    ) {
      hits.push(hit("时间线", `时间线事件“${event.title}”的状态变化`));
    }
    if (
      kind === "item" &&
      event.stateChanges.some(
        (change) => change.entityType === "item" && change.entityId === id,
      )
    ) {
      hits.push(hit("时间线", `时间线事件“${event.title}”的状态变化`));
    }
  }
  return hits;
}

function collectFactionReferenceHits(
  factions: readonly FactionRecord[],
  kind: "character" | "item",
  id: string,
): readonly InboundReferenceHit[] {
  const hits: InboundReferenceHit[] = [];
  for (const faction of factions) {
    if (kind === "character") {
      faction.members.forEach((member) => {
        if (member.characterId === id) {
          hits.push(hit("势力组织", `势力“${faction.name}”的成员“${member.name}”`));
        }
      });
      faction.links.forEach((link) => {
        if (link.kind === "character" && link.targetId === id) {
          hits.push(hit("势力组织", `势力“${faction.name}”的链接“${link.label}”`));
        }
      });
    } else {
      faction.resources.forEach((resource) => {
        if (resource.itemId === id) {
          hits.push(hit("势力组织", `势力“${faction.name}”的资源“${resource.name}”`));
        }
      });
      faction.links.forEach((link) => {
        if (link.kind === "item" && link.targetId === id) {
          hits.push(hit("势力组织", `势力“${faction.name}”的链接“${link.label}”`));
        }
      });
    }
  }
  return hits;
}

export type CrossLibraryTargetKind =
  | "character"
  | "faction"
  | "item"
  | "location";

/**
 * 查找目标实体被哪些库引用（删除保护用）。
 * 除修炼体系外，读取失败的文件按"无引用"处理——删除保护只是预防性检查，
 * 不应被损坏文件阻塞；修炼体系解析失败按"存在潜在引用"阻止删除（fail-closed），
 * 避免物品在被引用时因检查失效而被误删。
 */
export async function findInboundReferences(
  storage: WorkbenchStorage,
  kind: CrossLibraryTargetKind,
  id: string,
  projection?: WorkbenchProjection,
): Promise<readonly InboundReferenceHit[]> {
  if (projection?.isAvailable) {
    try {
      return (await projection.inboundRefs(kind, id)).map(projectionInboundHit);
    } catch {
      // 投影损坏或被清理时直接回退事实源；删除保护不依赖缓存可用性。
    }
  }

  const [timelineContent, factionsContent, charactersContent, cultivationContent, narrativeContent] =
    await Promise.all([
      loadOptionalJson(storage, TIMELINE_LIBRARY_PATH),
      loadOptionalJson(storage, FACTION_LIBRARY_PATH),
      loadOptionalJson(storage, "characters/index.json"),
      loadOptionalJson(storage, CULTIVATION_ECOLOGY_PATH),
      loadOptionalJson(storage, NARRATIVE_ENGINEERING_PATH),
    ]);

  const hits: InboundReferenceHit[] = [];
  if (timelineContent !== null) {
    try {
      const library = parseTimelineLibrary(timelineContent);
      hits.push(
        ...collectTimelineReferenceHits(library.events, kind, id),
      );
    } catch {
      // 时间线损坏时无法判断引用，跳过（保存时间线时已有严格校验兜底）。
    }
  }
  if (factionsContent !== null) {
    try {
      const library = parseFactionLibrary(factionsContent);
      if (kind === "character" || kind === "item") {
        hits.push(...collectFactionReferenceHits(library.factions, kind, id));
      }
    } catch {
      // 同上。
    }
  }
  if (kind === "item" && charactersContent !== null) {
    try {
      const index = parseCharacterLibraryIndex(charactersContent);
      const repository = createNovelCharacterLibraryRepository(storage);
      const characters = await Promise.all(
        index.characters.map(async (entry) =>
          (await repository.loadCharacter(entry)).record,
        ),
      );
      characters.forEach((character) => {
        if (character.inventory.some((entry) => entry.itemId === id)) {
          hits.push(hit("人物库", `角色“${character.name}”的物品栏`));
        }
      });
    } catch {
      // 同上。
    }
  }
  if (kind === "item" && cultivationContent !== null) {
    try {
      // 修炼体系的 itemIds 引用（法门/秘籍/阵法）通过对象遍历收集，避免依赖体系版本。
      const parsed = JSON.parse(cultivationContent) as unknown;
      collectCultivationItemHits(parsed, id, hits);
    } catch {
      // 修炼体系事实源损坏时按“存在潜在引用”处理（fail-closed），
      // 避免物品在被引用时因检查失效而被误删。
      hits.push(
        hit(
          "修炼体系",
          "事实源文件无法解析，无法确认物品引用，已阻止删除",
        ),
      );
    }
  }
  if (kind === "character" && narrativeContent !== null) {
    try {
      const parsed = JSON.parse(narrativeContent) as {
        readonly lines?: readonly { readonly title?: unknown; readonly protagonistCharacterId?: unknown }[];
        readonly arcs?: readonly { readonly title?: unknown; readonly characterId?: unknown }[];
        readonly chapters?: readonly { readonly title?: unknown; readonly sections?: readonly { readonly povCharacterId?: unknown }[] }[];
      };
      parsed.lines?.forEach((line) => {
        if (line.protagonistCharacterId === id) {
          hits.push(hit("剧情工程", `线路“${String(line.title ?? "未命名")}”的主角`));
        }
      });
      parsed.arcs?.forEach((arc) => {
        if (arc.characterId === id) {
          hits.push(hit("剧情工程", `故事弧“${String(arc.title ?? "未命名")}”的关联角色`));
        }
      });
      parsed.chapters?.forEach((chapter) => {
        chapter.sections?.forEach((section) => {
          if (section.povCharacterId === id) {
            hits.push(hit("剧情工程", `章节“${String(chapter.title ?? "未命名")}”的场景视角`));
          }
        });
      });
    } catch {
      // 同上。
    }
  }
  return hits;
}

interface CultivationItemRefShape {
  readonly itemIds?: readonly unknown[];
}

function collectCultivationItemHits(
  value: unknown,
  id: string,
  hits: InboundReferenceHit[],
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const itemIds = (record as CultivationItemRefShape).itemIds;
  if (Array.isArray(itemIds) && itemIds.includes(id)) {
    const name =
      typeof record.name === "string" && record.name
        ? record.name
        : "未命名";
    hits.push(hit("修炼体系", `“${name}”的关联物品`));
  }
  Object.values(record).forEach((child) => {
    if (Array.isArray(child)) {
      child.forEach((entry) => collectCultivationItemHits(entry, id, hits));
    } else {
      collectCultivationItemHits(child, id, hits);
    }
  });
}

/** 把命中列表格式化为可读的提示文本。 */
export function formatInboundReferenceHits(
  hits: readonly InboundReferenceHit[],
): string {
  return hits
    .map((entry) => `${entry.library}：${entry.location}`)
    .join("；");
}
