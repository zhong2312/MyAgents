import type { WorkbenchProjection, WorkbenchStorage } from "@/workbench-sdk";
import {
  NARRATIVE_ENGINEERING_INDEX_PATH,
  loadNarrativeEngineeringFiles,
  narrativeRecordPath,
} from "../../../../../shared/workbenches/novel/narrativeEngineeringStorage";
import {
  TIMELINE_INDEX_PATH,
  loadTimelineFiles,
  timelineRecordPath,
} from "../../../../../shared/workbenches/novel/timelineStorage";
import {
  FACTION_INDEX_PATH,
  factionRecordPath,
  loadFactionFiles,
} from "../../../../../shared/workbenches/novel/factionStorage";
import {
  LOCATION_INDEX_PATH,
  loadLocationFiles,
  locationRecordPath,
} from "../../../../../shared/workbenches/novel/locationStorage";
import {
  INSPIRATION_INDEX_PATH,
  inspirationRecordPath,
  loadInspirationFiles,
} from "../../../../../shared/workbenches/novel/inspirationStorage";
import {
  CULTIVATION_ECOLOGY_INDEX_PATH,
  loadCultivationEcologyFiles,
} from "../../../../../shared/workbenches/novel/cultivationEcologyStorage";

import { parseCharacterLibraryIndex } from "../../modules/characters";
import { parseFactionLibrary } from "../../modules/factions/entities/factionLibrarySchema";
import { parseItemLibraryIndex } from "../../itemLibrarySchema";
import { parseLocationLibraryIndex } from "../../modules/locations/entities/locationLibrarySchema";
import {
  MAP_LIBRARY_PATH,
  mapRecordPath,
  parseMapLibraryIndex,
} from "../../modules/maps/entities/mapSchema";
import { parseNovelChapterIndex } from "../../modules/project/entities/projectSchema";
import { parseNarrativeEngineering } from "../../narrativeEngineeringSchema";
import { parseInspirationLibrary } from "../../inspirationSchema";
import { parseTimelineLibrary } from "../../timelineLibrarySchema";
import { parseSettingLibrarySpatialTree } from "../../settingLibrarySchema";

/** 实体种类（对应可定位的领域对象）。 */
export type DomainEntityKind =
  | "character"
  | "faction"
  | "item"
  | "location"
  | "setting"
  | "event"
  | "narrativeChapter"
  | "chapter"
  | "inspiration"
  | "research"
  | "map"
  | "cultivationSystem"
  | "plotLine"
  | "storyArc"
  | "narrativeDirectory";

export const DOMAIN_ENTITY_KIND_LABELS: Readonly<
  Record<DomainEntityKind, string>
> = Object.freeze({
  character: "人物",
  faction: "势力",
  item: "物品",
  location: "地点",
  setting: "设定",
  event: "事件",
  narrativeChapter: "剧情规划",
  chapter: "正文章节",
  inspiration: "灵感",
  research: "资料",
  map: "地图",
  cultivationSystem: "修行体系",
  plotLine: "剧情线路",
  storyArc: "故事弧",
  narrativeDirectory: "剧情目录",
});

/**
 * 领域实体投影：不复制正文/概要之外的派生数据，
 * 只保留用于检索、展示与定位的最小字段。
 */
export interface DomainEntityRef {
  readonly kind: DomainEntityKind;
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  /** 工作区相对来源路径（定位来源文件用）。 */
  readonly sourcePath: string;
  /** 定位到具体实体的 route 与聚焦参数（T3 消费）。 */
  readonly route: string;
  readonly focus: Readonly<Record<string, string>>;
}

export interface DomainIndex {
  readonly entities: readonly DomainEntityRef[];
  readonly builtAt: string;
}

function clip(value: string, limit = 160): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

async function loadOptional(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  try {
    const [info] = await storage.stat([path]);
    if (!info?.exists) return null;
    return (await storage.readText(path)).content;
  } catch {
    return null;
  }
}

async function loadOptionalFaction(
  storage: WorkbenchStorage,
): Promise<ReturnType<typeof parseFactionLibrary> | null> {
  try {
    const [info] = await storage.stat([FACTION_INDEX_PATH]);
    if (!info?.exists || info.kind !== "file") return null;
    const loaded = await loadFactionFiles(
      async (path) => (await storage.readText(path)).content,
    );
    return parseFactionLibrary(JSON.stringify(loaded.library));
  } catch {
    return null;
  }
}

async function loadOptionalLocation(storage: WorkbenchStorage) {
  try {
    const [info] = await storage.stat([LOCATION_INDEX_PATH]);
    if (!info?.exists || info.kind !== "file") return null;
    const loaded = await loadLocationFiles(
      async (path) => (await storage.readText(path)).content,
    );
    return parseLocationLibraryIndex(JSON.stringify(loaded.library));
  } catch {
    return null;
  }
}

async function loadOptionalInspiration(storage: WorkbenchStorage) {
  try {
    const [info] = await storage.stat([INSPIRATION_INDEX_PATH]);
    if (!info?.exists || info.kind !== "file") return null;
    const loaded = await loadInspirationFiles(
      async (path) => (await storage.readText(path)).content,
    );
    return parseInspirationLibrary(JSON.stringify(loaded.library));
  } catch {
    return null;
  }
}

async function loadOptionalNarrative(storage: WorkbenchStorage) {
  try {
    const [info] = await storage.stat([NARRATIVE_ENGINEERING_INDEX_PATH]);
    if (!info?.exists || info.kind !== "file") return null;
    const loaded = await loadNarrativeEngineeringFiles(
      async (path) => (await storage.readText(path)).content,
    );
    return parseNarrativeEngineering(JSON.stringify(loaded.library));
  } catch {
    return null;
  }
}

async function loadOptionalCultivation(storage: WorkbenchStorage) {
  try {
    const [info] = await storage.stat([CULTIVATION_ECOLOGY_INDEX_PATH]);
    if (!info?.exists || info.kind !== "file") return null;
    return (
      await loadCultivationEcologyFiles(
        async (path) => (await storage.readText(path)).content,
      )
    ).ecology;
  } catch {
    return null;
  }
}

async function appendNonProjectedEntities(
  storage: WorkbenchStorage,
  entities: DomainEntityRef[],
): Promise<void> {
  const spatial = await loadOptional(
    storage,
    "world/setting-library/spatial-tree.json",
  );
  if (spatial) {
    const parsed = (() => {
      try {
        return parseSettingLibrarySpatialTree(spatial);
      } catch {
        return null;
      }
    })();
    for (const node of parsed?.nodes ?? []) {
      entities.push({
        kind: "setting",
        id: node.id,
        name: node.name,
        aliases: [],
        summary: "",
        sourcePath: "world/setting-library/spatial-tree.json",
        route: "lore",
        focus: { nodeId: node.id },
      });
    }
  }

  const manuscript = await loadOptional(storage, "manuscript/index.json");
  if (manuscript) {
    const parsed = (() => {
      try {
        return parseNovelChapterIndex(manuscript);
      } catch {
        return null;
      }
    })();
    for (const chapter of parsed?.chapters ?? []) {
      entities.push({
        kind: "chapter",
        id: chapter.id,
        name: chapter.title,
        aliases: [],
        summary: "",
        sourcePath: "manuscript/index.json",
        route: "manuscript",
        focus: { chapterId: chapter.id },
      });
    }
  }

  const inspiration = await loadOptionalInspiration(storage);
  if (inspiration) {
    for (const item of inspiration.items) {
      entities.push({
        kind: "inspiration",
        id: item.id,
        name: item.title,
        aliases: [],
        summary: clip(item.body),
        sourcePath: inspirationRecordPath(item.id),
        route: "inspiration",
        focus: { inspirationId: item.id },
      });
    }
  }

  const maps = await loadOptional(storage, MAP_LIBRARY_PATH);
  if (maps) {
    let parsed: ReturnType<typeof parseMapLibraryIndex> | null = null;
    try {
      parsed = parseMapLibraryIndex(maps);
    } catch {
      parsed = null;
    }
    for (const map of parsed?.maps ?? []) {
      entities.push({
        kind: "map",
        id: map.id,
        name: map.name,
        aliases: [],
        summary: map.projectionType,
        sourcePath: mapRecordPath(map.id),
        route: "map",
        focus: { mapId: map.id },
      });
    }
  }

  const cultivation = await loadOptionalCultivation(storage);
  for (const system of cultivation?.systems ?? []) {
    entities.push({
      kind: "cultivationSystem",
      id: system.id,
      name: system.name,
      aliases: [],
      summary: clip(system.summary),
      sourcePath: `world/cultivation/systems/${system.id}/system.json`,
      route: "powers",
      focus: { systemId: system.id },
    });
  }

  const narrative = await loadOptionalNarrative(storage);
  for (const line of narrative?.lines ?? []) {
    entities.push({
      kind: "plotLine",
      id: line.id,
      name: line.title,
      aliases: [],
      summary: clip(line.content || line.premise),
      sourcePath: narrativeRecordPath("lines", line.id),
      route: "narrative",
      focus: { lineId: line.id },
    });
  }
  for (const arc of narrative?.arcs ?? []) {
    entities.push({
      kind: "storyArc",
      id: arc.id,
      name: arc.title,
      aliases: [],
      summary: clip(arc.content),
      sourcePath: narrativeRecordPath("arcs", arc.id),
      route: "narrative",
      focus: { arcId: arc.id },
    });
  }
  for (const directory of narrative?.directories ?? []) {
    entities.push({
      kind: "narrativeDirectory",
      id: directory.id,
      name: directory.title,
      aliases: [],
      summary: clip(directory.description),
      sourcePath: narrativeRecordPath("directories", directory.id),
      route: "narrative",
      focus: { directoryId: directory.id },
    });
  }

  const collectResearch = async (directory: string): Promise<void> => {
    const entries = await storage
      .list(directory)
      .catch(() => [] as Awaited<ReturnType<WorkbenchStorage["list"]>>);
    for (const entry of entries) {
      if (
        entry.path === "research/trash" ||
        entry.path.startsWith("research/trash/")
      ) {
        continue;
      }
      if (entry.kind === "directory") {
        await collectResearch(entry.path);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      entities.push({
        kind: "research",
        id: entry.path,
        name: entry.name.replace(/\.md$/i, ""),
        aliases: [],
        summary: "",
        sourcePath: entry.path,
        route: "research",
        focus: { researchPath: entry.path },
      });
    }
  };
  await collectResearch("research");
}

function projectionEntityToDomainRef(
  entity: Awaited<ReturnType<WorkbenchProjection["listEntities"]>>[number],
): DomainEntityRef | null {
  switch (entity.kind) {
    case "character":
      return {
        kind: "character",
        id: entity.id,
        name: entity.name,
        aliases: entity.aliases,
        summary: clip(entity.summary),
        sourcePath: entity.sourcePath,
        route: "characters",
        focus: { characterId: entity.id },
      };
    case "faction":
      return {
        kind: "faction",
        id: entity.id,
        name: entity.name,
        aliases: entity.aliases,
        summary: clip(entity.summary),
        sourcePath: entity.sourcePath,
        route: "factions",
        focus: { factionId: entity.id },
      };
    case "item":
      return {
        kind: "item",
        id: entity.id,
        name: entity.name,
        aliases: entity.aliases,
        summary: clip(entity.summary),
        sourcePath: entity.sourcePath,
        route: "items",
        focus: { itemId: entity.id },
      };
    case "location":
      return {
        kind: "location",
        id: entity.id,
        name: entity.name,
        aliases: entity.aliases,
        summary: clip(entity.summary),
        sourcePath: entity.sourcePath,
        route: "lore",
        focus: { locationId: entity.id },
      };
    case "event":
      return {
        kind: "event",
        id: entity.id,
        name: entity.name,
        aliases: entity.aliases,
        summary: clip(entity.summary),
        sourcePath: entity.sourcePath,
        route: "timeline",
        focus: { eventId: entity.id },
      };
    case "narrativeChapter":
      return {
        kind: "narrativeChapter",
        id: entity.id,
        name: entity.name,
        aliases: entity.aliases,
        summary: clip(entity.summary),
        sourcePath: entity.sourcePath,
        route: "narrative",
        focus: { narrativeChapterId: entity.id },
      };
    default:
      return null;
  }
}

/** 从各库 JSON 投影实体索引（内存构建，不写盘）。 */
export async function buildDomainIndex(
  storage: WorkbenchStorage,
  projection?: WorkbenchProjection,
): Promise<DomainIndex> {
  if (projection?.isAvailable) {
    try {
      const entities = (await projection.listEntities())
        .map(projectionEntityToDomainRef)
        .filter((entity): entity is DomainEntityRef => entity !== null);
      await appendNonProjectedEntities(storage, entities);
      return {
        entities: Object.freeze(entities),
        builtAt: new Date().toISOString(),
      };
    } catch {
      // 投影是可重建派生层。不可用或损坏时回退到各领域事实源。
    }
  }

  const entities: DomainEntityRef[] = [];

  const characters = await loadOptional(storage, "characters/index.json");
  if (characters) {
    let parsedCharacters: ReturnType<typeof parseCharacterLibraryIndex> | null =
      null;
    try {
      parsedCharacters = parseCharacterLibraryIndex(characters);
    } catch {
      parsedCharacters = null;
    }
    for (const character of parsedCharacters?.characters ?? []) {
      entities.push({
        kind: "character",
        id: character.id,
        name: character.name,
        aliases: [],
        summary: clip(character.summary),
        sourcePath: character.recordPath,
        route: "characters",
        focus: { characterId: character.id },
      });
    }
  }

  const factions = await loadOptionalFaction(storage);
  if (factions) {
    for (const faction of factions.factions) {
      entities.push({
        kind: "faction",
        id: faction.id,
        name: faction.name,
        aliases: [],
        summary: clip(faction.summary),
        sourcePath: factionRecordPath(faction.id),
        route: "factions",
        focus: { factionId: faction.id },
      });
    }
  }

  const items = await loadOptional(storage, "world/items/index.json");
  if (items) {
    let parsedItems: ReturnType<typeof parseItemLibraryIndex> | null = null;
    try {
      parsedItems = parseItemLibraryIndex(items);
    } catch {
      parsedItems = null;
    }
    for (const item of parsedItems?.items ?? []) {
      entities.push({
        kind: "item",
        id: item.id,
        name: item.name,
        aliases: [],
        summary: clip(item.summary),
        sourcePath: "world/items/index.json",
        route: "items",
        focus: { itemId: item.id },
      });
    }
  }

  const locations = await loadOptionalLocation(storage);
  if (locations) {
    for (const location of locations.locations) {
      entities.push({
        kind: "location",
        id: location.id,
        name: location.name,
        aliases: [...location.aliases],
        summary: clip(location.summary),
        sourcePath: locationRecordPath(location.id),
        route: "lore",
        focus: { locationId: location.id },
      });
    }
  }

  const narrative = await loadOptionalNarrative(storage);
  if (narrative) {
    for (const plan of narrative.chapters) {
      entities.push({
        kind: "narrativeChapter",
        id: plan.id,
        name: plan.title,
        aliases: [],
        summary: clip(plan.description),
        sourcePath: narrativeRecordPath("chapters", plan.id),
        route: "narrative",
        focus: { narrativeChapterId: plan.id },
      });
    }
  }

  const timelineIndex = await loadOptional(storage, TIMELINE_INDEX_PATH);
  if (timelineIndex) {
    let events: ReturnType<typeof parseTimelineLibrary>["events"] = [];
    try {
      const timeline = await loadTimelineFiles(
        async (path) => (await storage.readText(path)).content,
      );
      events = parseTimelineLibrary(JSON.stringify(timeline.library)).events;
    } catch {
      events = [];
    }
    for (const event of events) {
      entities.push({
        kind: "event",
        id: event.id,
        name: event.title,
        aliases: [],
        summary: clip(event.summary),
        sourcePath: timelineRecordPath("events", event.id),
        route: "timeline",
        focus: { eventId: event.id },
      });
    }
  }

  await appendNonProjectedEntities(storage, entities);

  return {
    entities: Object.freeze(entities),
    builtAt: new Date().toISOString(),
  };
}

/** 按关键词与类型过滤实体（名称/别名/摘要匹配）。 */
export function searchDomainIndex(
  index: DomainIndex,
  query: string,
  kinds?: readonly DomainEntityKind[],
  limit = 50,
): readonly DomainEntityRef[] {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const kindSet = kinds ? new Set(kinds) : null;
  const scored: { ref: DomainEntityRef; score: number }[] = [];
  for (const ref of index.entities) {
    if (kindSet && !kindSet.has(ref.kind)) continue;
    if (!needle) {
      scored.push({ ref, score: 0 });
      continue;
    }
    const name = ref.name.toLocaleLowerCase("zh-CN");
    const aliases = ref.aliases.join(" ").toLocaleLowerCase("zh-CN");
    const summary = ref.summary.toLocaleLowerCase("zh-CN");
    let score = 0;
    if (name === needle) score = 100;
    else if (name.includes(needle)) score = 80;
    else if (aliases.includes(needle)) score = 60;
    else if (summary.includes(needle)) score = 30;
    else continue;
    scored.push({ ref, score });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score || left.ref.name.localeCompare(right.ref.name),
  );
  return Object.freeze(scored.slice(0, limit).map(({ ref }) => ref));
}
